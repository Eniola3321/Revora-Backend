import { NextFunction, Request, Response, Router } from 'express';
import { Pool } from 'pg';
import { AppError, Errors } from '../lib/errors';
import { MetricsCollector } from '../lib/metrics';
import {
  classifyStellarRPCFailure,
  StellarRPCFailureClass,
} from "../lib/stellarRpcFailure";
import { DbHealthResult, PoolMetrics } from "../db/client";

export type HealthDependency = "database" | "stellar-horizon" | "db-pool";

export type DependencyStatus = "up" | "down" | "degraded" | "unknown";

export interface DependencyHealth {
  name: HealthDependency;
  status: DependencyStatus;
  latencyMs: number;
  healthy: boolean;
  dependsOn?: HealthDependency[];
  details?: Record<string, unknown>;
  error?: string;
}

export interface HealthDependencyGraph {
  status: "healthy" | "degraded" | "unhealthy";
  service: string;
  version: string;
  timestamp: string;
  uptime: number;
  checks: DependencyHealth[];
  requestId?: string;
}

interface QueryableDb {
  query(sql: string, params?: unknown[]): Promise<unknown>;
}

interface DbHealthChecker {
  (): Promise<DbHealthResult>;
}

const HORIZON_TIMEOUT_MS = 5000;
const POOL_HEALTHY_THRESHOLD = 0.8;
const POOL_DEGRADED_THRESHOLD = 0.9;

function getServiceVersion(): string {
  return process.env.npm_package_version ?? "0.1.0";
}

function getUptimeSeconds(): number {
  return Math.floor(process.uptime());
}

function calculatePoolUtilization(pool: PoolMetrics | undefined): number {
  if (!pool || pool.maxConnections === 0) return 0;
  return pool.totalCount / pool.maxConnections;
}

function classifyPoolStatus(pool: PoolMetrics | undefined): DependencyStatus {
  if (!pool) return "unknown";
  const utilization = calculatePoolUtilization(pool);
  if (utilization >= POOL_DEGRADED_THRESHOLD) return "degraded";
  if (utilization >= POOL_HEALTHY_THRESHOLD) return "up";
  return "up";
}

function logHealthCheck(
  level: "info" | "warn" | "error",
  message: string,
  data: Record<string, unknown>,
): void {
  const logEntry = {
    timestamp: new Date().toISOString(),
    level,
    component: "health",
    message,
    ...data,
  };
  console.log(JSON.stringify(logEntry));
}

/**
 * Maps dependency failures into a stable, reviewable API error shape.
 * Raw upstream error messages are intentionally not exposed to clients.
 */
export function mapHealthDependencyFailure(
  dependency: HealthDependency,
  cause: unknown,
): AppError {
  const details: Record<string, unknown> = { dependency };

  if (dependency === "stellar-horizon") {
    const failureClass = classifyStellarRPCFailure(cause);
    details.failureClass = failureClass;

    if (typeof cause === "object" && cause !== null) {
      const status = (cause as { status?: unknown }).status;
      if (typeof status === "number") {
        details.upstreamStatus = status;
      }
    }
  }

  return Errors.serviceUnavailable("Dependency unavailable", details);
}

async function checkStellarHorizon(): Promise<DependencyHealth> {
  const start = Date.now();
  const horizonUrl =
    process.env.STELLAR_HORIZON_URL || "https://horizon.stellar.org";

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), HORIZON_TIMEOUT_MS);

    const response = await fetch(horizonUrl, { signal: controller.signal });
    clearTimeout(timeoutId);

    const latencyMs = Date.now() - start;

    if (!response.ok) {
      const failureClass = classifyStellarRPCFailure({
        status: response.status,
      });
      logHealthCheck("error", "Stellar Horizon health check failed", {
        dependency: "stellar-horizon",
        status: response.status,
        failureClass,
        latencyMs,
      });

      return {
        name: "stellar-horizon",
        status: "down",
        latencyMs,
        healthy: false,
        dependsOn: [],
        details: {
          failureClass,
          upstreamStatus: response.status,
          url: horizonUrl,
        },
      };
    }

    logHealthCheck("info", "Stellar Horizon health check passed", {
      dependency: "stellar-horizon",
      latencyMs,
      status: response.status,
    });

    return {
      name: "stellar-horizon",
      status: "up",
      latencyMs,
      healthy: true,
      dependsOn: [],
      details: {
        url: horizonUrl,
        statusCode: response.status,
      },
    };
  } catch (error) {
    const latencyMs = Date.now() - start;
    const failureClass = classifyStellarRPCFailure(error);

    logHealthCheck("error", "Stellar Horizon health check error", {
      dependency: "stellar-horizon",
      failureClass,
      latencyMs,
      error: error instanceof Error ? error.name : "Unknown",
    });

    return {
      name: "stellar-horizon",
      status: "down",
      latencyMs,
      healthy: false,
      dependsOn: [],
      details: {
        failureClass,
        url: horizonUrl,
      },
      error:
        failureClass === StellarRPCFailureClass.TIMEOUT
          ? "timeout"
          : "connection_error",
    };
  }
}

async function checkDatabase(
  dbHealth: DbHealthChecker,
): Promise<DependencyHealth> {
  const result = await dbHealth();

  if (result.healthy) {
    const poolStatus = classifyPoolStatus(result.pool);
    const utilization = calculatePoolUtilization(result.pool);

    logHealthCheck("info", "Database health check passed", {
      dependency: "database",
      latencyMs: result.latencyMs,
      poolStatus,
      utilization: Math.round(utilization * 100),
    });

    return {
      name: "database",
      status: poolStatus,
      latencyMs: result.latencyMs,
      healthy: poolStatus !== "down",
      dependsOn: result.pool ? ["db-pool"] : [],
      details: result.pool
        ? {
            ...result.pool,
            utilizationPercent: Math.round(utilization * 100),
          }
        : undefined,
    };
  }

  logHealthCheck("error", "Database health check failed", {
    dependency: "database",
    latencyMs: result.latencyMs,
    error: "sanitized-db-error",
  });

  return {
    name: "database",
    status: "down",
    latencyMs: result.latencyMs,
    healthy: false,
    dependsOn: result.pool ? ["db-pool"] : [],
    error: "sanitized-db-error",
  };
}

function evaluateOverallStatus(
  checks: DependencyHealth[],
): "healthy" | "degraded" | "unhealthy" {
  const hasDown = checks.some((c) => c.status === "down");
  const hasDegraded = checks.some((c) => c.status === "degraded");

  if (hasDown) return "unhealthy";
  if (hasDegraded) return "degraded";
  return "healthy";
}

export const healthRootHandler =
  (dbHealth: DbHealthChecker) =>
  async (req: Request, res: Response): Promise<void> => {
    const requestId = req.headers["x-request-id"] as string | undefined;

    const [dbCheck, stellarCheck] = await Promise.all([
      checkDatabase(dbHealth),
      checkStellarHorizon(),
    ]);

    const checks = [dbCheck, stellarCheck];
    const status = evaluateOverallStatus(checks);

    const response: HealthDependencyGraph = {
      status,
      service: "revora-backend",
      version: getServiceVersion(),
      timestamp: new Date().toISOString(),
      uptime: getUptimeSeconds(),
      checks,
      requestId,
    };

    const statusCode = status === "unhealthy" ? 503 : 200;
    res.status(statusCode).json(response);
  };

export const healthReadyHandler =
  (db: QueryableDb, metrics?: MetricsCollector) =>
  async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    const startTime = Date.now();

    try {
      await db.query('SELECT 1');
      metrics?.incrementCounter('health_checks_total', { check: 'database', status: 'success' });
    } catch (dbError) {
      metrics?.incrementCounter('health_checks_total', { check: 'database', status: 'failure' });
      next(mapHealthDependencyFailure('database', dbError));
      return;
    }

    logHealthCheck("info", "Readiness probe passed", {
      requestId,
      latencyMs: Math.max(dbCheck.latencyMs, stellarCheck.latencyMs),
    });

      if (!response.ok) {
        metrics?.incrementCounter('health_checks_total', { check: 'stellar-horizon', status: 'failure' });
        next(mapHealthDependencyFailure('stellar-horizon', { status: response.status }));
        return;
      }
      metrics?.incrementCounter('health_checks_total', { check: 'stellar-horizon', status: 'success' });
    } catch (stellarError) {
      metrics?.incrementCounter('health_checks_total', { check: 'stellar-horizon', status: 'failure' });
      next(mapHealthDependencyFailure('stellar-horizon', stellarError));
      return;
    }

    const duration = Date.now() - startTime;
    metrics?.recordHistogram('health_check_duration_ms', duration, { endpoint: 'ready' });

    res.status(200).json({
      ready: true,
      service: "revora-backend",
      timestamp: new Date().toISOString(),
      check: dbCheck.name,
      requestId,
    });
  };

export const createHealthRouter = (db: QueryableDb, metrics?: MetricsCollector): Router => {
  const router = Router();
  router.get('/ready', healthReadyHandler(db, metrics));
  return router;
};

export default createHealthRouter;
