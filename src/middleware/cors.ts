import cors from "cors";
import { env } from "../config/env";
import { globalLogger } from "../lib/logger";

/**
 * Creates a CORS middleware configured from environment variables.
 *
 * Production-grade CORS configuration with security hardening:
 * - Explicit origin allowlist validation
 * - Default deny for unknown origins
 * - Structured logging for security events
 * - Environment-driven configuration
 * - Request ID correlation for tracing
 *
 * Security Assumptions:
 * - ALLOWED_ORIGINS must be explicitly set in production
 * - Origins are validated against allowlist
 * - Denied requests are logged for security monitoring
 * - No origin requests (curl, health checks) can be optionally allowed
 *
 * ENV:
 * ALLOWED_ORIGINS = "https://app.example.com,https://admin.example.com"
 * CORS_ALLOW_NO_ORIGIN = "true" (optional, defaults to false)
 */
export function createCorsMiddleware() {
  const allowedOrigins: string[] = env.ALLOWED_ORIGINS;

  const allowNoOrigin = process.env.CORS_ALLOW_NO_ORIGIN === "true";

  // Security validation: require explicit origins in production
  if (process.env.NODE_ENV === "production") {
    if (!allowedOrigins || allowedOrigins.length === 0) {
      globalLogger.error(
        "CORS security violation: ALLOWED_ORIGINS not configured in production",
        {
          securityEvent: "cors_config_error",
          allowedOriginsCount: allowedOrigins?.length ?? 0,
          allowNoOrigin,
        }
      );
      throw new Error("ALLOWED_ORIGINS must be configured in production environment");
    }
  }

  // Log configuration on startup
  globalLogger.info("CORS middleware initialized", {
    allowedOriginsCount: allowedOrigins.length,
    allowNoOrigin,
    environment: process.env.NODE_ENV,
  });

  return cors({
    origin(origin, callback) {
      // Allow requests without origin (health checks, curl, internal services)
      if (!origin) {
        if (allowNoOrigin) {
          globalLogger.debug("CORS: allowed request without origin", {
            allowNoOrigin: true,
          });
          return callback(null, true);
        }

        globalLogger.warn("CORS: denied request without origin", {
          securityEvent: "cors_no_origin_denied",
          allowNoOrigin: false,
        });
        return callback(null, false);
      }

      // Validate against allowlist
      if (allowedOrigins.includes(origin)) {
        globalLogger.debug("CORS: allowed origin", {
          origin,
          allowed: true,
        });
        return callback(null, true);
      }

      // Deny unknown origin
      globalLogger.warn("CORS: denied unknown origin", {
        origin,
        securityEvent: "cors_origin_denied",
        allowedOrigins,
      });
      return callback(null, false);
    },

    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "x-user-id", "x-user-role", "x-request-id"],
    optionsSuccessStatus: 200, // Some legacy browsers choke on 204
  });
}