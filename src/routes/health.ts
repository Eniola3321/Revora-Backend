import { NextFunction, Request, Response, Router } from 'express';
import { Pool } from 'pg';
import { AppError, Errors } from '../lib/errors';
import { MetricsCollector } from '../lib/metrics';
import {
  classifyStellarRPCFailure,
  StellarRPCFailureClass,
} from '../lib/stellarRpcFailure';

export type HealthDependency = 'database' | 'stellar-horizon';

interface QueryableDb {
  query(sql: string, params?: unknown[]): Promise<unknown>;
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

  if (dependency === 'stellar-horizon') {
    const failureClass = classifyStellarRPCFailure(cause);
    details.failureClass = failureClass;

    if (typeof cause === 'object' && cause !== null) {
      const status = (cause as { status?: unknown }).status;
      if (typeof status === 'number') {
        details.upstreamStatus = status;
      }
    }
  }

  return Errors.serviceUnavailable('Dependency unavailable', details);
}

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

    try {
      const horizonUrl = process.env.STELLAR_HORIZON_URL || 'https://horizon.stellar.org';
      const response = await fetch(horizonUrl);

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
      status: 'ok',
      db: 'up',
      stellar: 'up',
    });
  };

export const createHealthRouter = (db: QueryableDb, metrics?: MetricsCollector): Router => {
  const router = Router();
  router.get('/ready', healthReadyHandler(db, metrics));
  return router;
};

export default createHealthRouter;
