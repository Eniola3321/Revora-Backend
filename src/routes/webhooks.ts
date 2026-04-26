import { Router, Request, Response, raw } from 'express';
import { webhookAuth, WebhookAuthenticatedRequest } from '../middleware/webhookAuth';
import { verifyWebhookPayload } from '../lib/webhookSignature';
import { Errors } from '../lib/errors';
import { globalLogger } from '../lib/logger';

/**
 * @title Webhook Receiver Routes
 * @notice Express router for receiving and processing webhooks with signature verification.
 * @dev Provides endpoints for receiving webhooks from external services with HMAC-SHA256
 * signature verification to ensure authenticity.
 *
 * Security assumptions:
 * - Webhook secrets are securely stored in environment variables
 * - Signatures follow the format: sha256=<hex>
 * - Requests include a valid timestamp for replay protection (optional)
 *
 * Abuse/failure paths handled:
 * - Missing or invalid signatures
 * - Expired timestamps (replay attacks)
 * - Payload size limits
 * - Invalid JSON payloads
 */

/**
 * @notice Webhook event payload structure.
 */
export interface WebhookEvent {
  /** Unique event identifier */
  id: string;
  /** Event type (e.g., 'payment.completed', 'user.created') */
  event: string;
  /** Event payload data */
  data: unknown;
  /** Event timestamp (ISO 8601) */
  timestamp: string;
}

/**
 * @notice Webhook processing result.
 */
export interface WebhookProcessingResult {
  success: boolean;
  eventId?: string;
  message: string;
}

/**
 * @notice Handler function for processing webhook events.
 */
export type WebhookEventHandler = (event: WebhookEvent) => Promise<WebhookProcessingResult>;

/**
 * @notice Default webhook event handler that logs events.
 */
const defaultEventHandler: WebhookEventHandler = async (event: WebhookEvent) => {
  globalLogger.info('[Webhook] Received event', {
    eventType: event.event,
    eventId: event.id,
    eventTimestamp: event.timestamp,
  });

  return {
    success: true,
    eventId: event.id,
    message: `Event ${event.event} processed successfully`,
  };
};

/**
 * @notice Configuration options for the webhook router.
 */
export interface WebhookRouterConfig {
  /** Webhook secret for signature verification */
  secret: string;
  /** Custom event handler (default: logging handler) */
  eventHandler?: WebhookEventHandler;
  /** Whether to require timestamp for replay protection (default: true) */
  requireTimestamp?: boolean;
  /** Maximum webhook age in milliseconds (default: 5 minutes) */
  maxAgeMs?: number;
  /** Maximum payload size in bytes (default: 1MB) */
  maxPayloadSize?: number;
  /**
   * Allowed clock drift for future-dated timestamps in milliseconds (default: 30 seconds).
   * Sender clocks may run slightly ahead of the server clock; this tolerance avoids
   * spurious rejections without meaningfully widening the replay window.
   */
  clockSkewMs?: number;
  /** Custom webhook endpoint path (default: '/webhooks') */
  path?: string;
}

/**
 * @notice Validates the webhook event structure.
 * @param body The parsed request body
 * @returns Validation result with error message if invalid
 */
function validateWebhookEvent(body: unknown): { valid: boolean; error?: string; event?: WebhookEvent } {
  if (typeof body !== 'object' || body === null) {
    return { valid: false, error: 'Request body must be an object' };
  }

  const event = body as Partial<WebhookEvent>;

  if (!event.id || typeof event.id !== 'string') {
    return { valid: false, error: 'Missing or invalid event id' };
  }

  if (!event.event || typeof event.event !== 'string') {
    return { valid: false, error: 'Missing or invalid event type' };
  }

  if (event.data === undefined) {
    return { valid: false, error: 'Missing event data' };
  }

  if (!event.timestamp || typeof event.timestamp !== 'string') {
    return { valid: false, error: 'Missing or invalid timestamp' };
  }

  // Validate timestamp format
  const timestampDate = new Date(event.timestamp);
  if (isNaN(timestampDate.getTime())) {
    return { valid: false, error: 'Invalid timestamp format' };
  }

  return {
    valid: true,
    event: event as WebhookEvent,
  };
}

/**
 * @notice Creates an Express router for receiving webhooks with signature verification.
 * @dev Provides POST endpoint that verifies HMAC-SHA256 signatures before processing.
 *
 * @param config Router configuration options
 * @returns Configured Express router
 *
 * @example
 * ```typescript
 * // Basic usage
 * app.use(createWebhookRouter({
 *   secret: process.env.WEBHOOK_SECRET!
 * }));
 *
 * // With custom event handler
 * app.use(createWebhookRouter({
 *   secret: process.env.WEBHOOK_SECRET!,
 *   eventHandler: async (event) => {
 *     await processPayment(event.data);
 *     return { success: true, message: 'Payment processed' };
 *   },
 *   requireTimestamp: true,
 *   maxAgeMs: 300000 // 5 minutes
 * }));
 * ```
 */
export function createWebhookRouter(config: WebhookRouterConfig): Router {
  const {
    secret,
    eventHandler = defaultEventHandler,
    requireTimestamp = true,
    maxAgeMs = 5 * 60 * 1000, // 5 minutes
    maxPayloadSize = 1024 * 1024, // 1MB
    clockSkewMs = 30 * 1000, // 30 seconds clock drift tolerance
  } = config;

  const router = Router();

  // Apply raw body parser for signature verification
  router.post(
    '/',
    raw({ type: 'application/json', limit: `${maxPayloadSize}b` }),
    (req: Request, res: Response, next: Function): void => {
      // Verify signature manually since we have raw body
      const signature = req.headers['x-revora-signature'] as string | undefined;
      const payload = req.body as Buffer;

      if (!signature) {
        globalLogger.warn('[Webhook] Rejected: missing signature header', { path: req.path });
        const appErr = Errors.unauthorized('Webhook authentication required');
        res.status(appErr.statusCode).json(appErr.toResponse());
        return;
      }

      if (!verifyWebhookPayload(secret, payload, signature)) {
        globalLogger.warn('[Webhook] Rejected: signature verification failed', { path: req.path });
        const appErr = Errors.forbidden('Webhook verification failed');
        res.status(appErr.statusCode).json(appErr.toResponse());
        return;
      }

      // Optional timestamp validation for replay protection with clock skew tolerance
      if (requireTimestamp) {
        const timestampHeader = req.headers['x-webhook-timestamp'] ?? req.headers['x-revora-timestamp'];
        const timestampStr = Array.isArray(timestampHeader) ? timestampHeader[0] : timestampHeader;

        if (!timestampStr) {
          globalLogger.warn('[Webhook] Rejected: missing timestamp header', { path: req.path });
          const appErr = Errors.forbidden('Webhook timestamp required');
          res.status(appErr.statusCode).json(appErr.toResponse());
          return;
        }

        const timestamp = parseInt(timestampStr, 10);
        if (isNaN(timestamp)) {
          globalLogger.warn('[Webhook] Rejected: invalid timestamp format', { path: req.path });
          const appErr = Errors.forbidden('Invalid webhook timestamp');
          res.status(appErr.statusCode).json(appErr.toResponse());
          return;
        }

        const now = Date.now();
        const age = now - timestamp;

        // Negative age = future timestamp; allow up to clockSkewMs of sender clock drift.
        if (age < -clockSkewMs || age > maxAgeMs) {
          globalLogger.warn('[Webhook] Rejected: timestamp outside window', {
            path: req.path,
            age,
            maxAgeMs,
            clockSkewMs,
          });
          const appErr = Errors.forbidden('Webhook timestamp expired');
          res.status(appErr.statusCode).json(appErr.toResponse());
          return;
        }
      }

      // Parse JSON body for downstream handlers
      try {
        req.body = JSON.parse(payload.toString('utf8'));
        next();
      } catch {
        const appErr = Errors.badRequest('Request body is not valid JSON');
        res.status(appErr.statusCode).json(appErr.toResponse());
      }
    },
    async (req: Request, res: Response): Promise<void> => {
      try {
        // Validate event structure
        const validation = validateWebhookEvent(req.body);
        if (!validation.valid) {
          res.status(400).json({
            success: false,
            error: 'Invalid webhook event structure',
            message: validation.error,
          });
          return;
        }

        const event = validation.event!;
        const authReq = req as WebhookAuthenticatedRequest;

        // Process the event
        const result = await eventHandler(event);

        if (result.success) {
          res.status(200).json({
            success: true,
            eventId: result.eventId || event.id,
            message: result.message,
            receivedAt: new Date().toISOString(),
            verifiedAt: authReq.webhook?.timestamp?.toISOString(),
          });
        } else {
          res.status(422).json({
            success: false,
            eventId: event.id,
            error: 'Event processing failed',
            message: result.message,
          });
        }
      } catch (error) {
        globalLogger.error('[Webhook] Error processing webhook event', { error });
        const appErr = Errors.internal();
        res.status(appErr.statusCode).json(appErr.toResponse());
      }
    }
  );

  // Health check endpoint for webhook receiver
  router.get('/health', (_req: Request, res: Response): void => {
    res.status(200).json({
      status: 'ok',
      service: 'webhook-receiver',
      timestamp: new Date().toISOString(),
    });
  });

  return router;
}

/**
 * @notice Creates a webhook router with endpoint-specific secrets.
 * @dev Useful when receiving webhooks from multiple sources with different secrets.
 *
 * @param secretProvider Function that returns the secret for a given endpoint ID
 * @param config Additional router configuration
 * @returns Configured Express router
 *
 * @example
 * ```typescript
 * app.use('/webhooks/:endpointId', createMultiTenantWebhookRouter(
 *   async (endpointId) => {
 *     const endpoint = await db.webhookEndpoints.findById(endpointId);
 *     return endpoint?.secret;
 *   },
 *   {
 *     eventHandler: async (event, endpointId) => {
 *       // Process event with endpoint context
 *     }
 *   }
 * ));
 * ```
 */
export interface MultiTenantWebhookConfig extends Omit<WebhookRouterConfig, 'secret' | 'eventHandler'> {
  /** Event handler with endpoint ID context */
  eventHandler?: (event: WebhookEvent, endpointId: string) => Promise<WebhookProcessingResult>;
}

export function createMultiTenantWebhookRouter(
  secretProvider: (endpointId: string) => Promise<string | null | undefined>,
  config: MultiTenantWebhookConfig = {}
): Router {
  const {
    eventHandler = defaultEventHandler,
    requireTimestamp = true,
    maxAgeMs = 5 * 60 * 1000,
    maxPayloadSize = 1024 * 1024,
    clockSkewMs = 30 * 1000,
  } = config;

  const router = Router({ mergeParams: true });

  router.post(
    '/',
    raw({ type: 'application/json', limit: `${maxPayloadSize}b` }),
    async (req: Request, res: Response, next: Function): Promise<void> => {
      const endpointId = req.params.endpointId;

      if (!endpointId) {
        globalLogger.warn('[Webhook] Rejected: missing endpoint identifier', { path: req.path });
        const appErr = Errors.badRequest('Missing endpoint identifier');
        res.status(appErr.statusCode).json(appErr.toResponse());
        return;
      }

      // Fetch secret for this endpoint
      let secret: string | null | undefined;
      try {
        secret = await secretProvider(endpointId);
      } catch (error) {
        globalLogger.error('[Webhook] Error fetching secret', { endpointId, error });
        const appErr = Errors.internal();
        res.status(appErr.statusCode).json(appErr.toResponse());
        return;
      }

      if (!secret) {
        globalLogger.warn('[Webhook] Endpoint not found', { endpointId });
        res.status(404).json({
          success: false,
          error: 'Webhook endpoint not found or inactive',
        });
        return;
      }

      // Verify signature
      const signature = req.headers['x-revora-signature'] as string | undefined;
      const payload = req.body as Buffer;

      if (!signature) {
        globalLogger.warn('[Webhook] Rejected: missing signature header', { path: req.path, endpointId });
        const appErr = Errors.unauthorized('Webhook authentication required');
        res.status(appErr.statusCode).json(appErr.toResponse());
        return;
      }

      if (!verifyWebhookPayload(secret, payload, signature)) {
        globalLogger.warn('[Webhook] Rejected: signature mismatch', { path: req.path, endpointId });
        const appErr = Errors.forbidden('Webhook verification failed');
        res.status(appErr.statusCode).json(appErr.toResponse());
        return;
      }

      // Parse JSON body for downstream handlers
      try {
        req.body = JSON.parse(payload.toString('utf8'));
        next();
      } catch {
        const appErr = Errors.badRequest('Request body is not valid JSON');
        res.status(appErr.statusCode).json(appErr.toResponse());
      }
    },
    async (req: Request, res: Response): Promise<void> => {
      try {
        const validation = validateWebhookEvent(req.body);
        if (!validation.valid) {
          res.status(400).json({
            success: false,
            error: 'Invalid webhook event structure',
            message: validation.error,
          });
          return;
        }

        const event = validation.event!;
        const endpointId = req.params.endpointId;

        // Use multi-tenant handler if provided, otherwise use default
        const handler = config.eventHandler
          ? (e: WebhookEvent) => config.eventHandler!(e, endpointId)
          : defaultEventHandler;

        const result = await handler(event);

        if (result.success) {
          res.status(200).json({
            success: true,
            eventId: result.eventId || event.id,
            endpointId,
            message: result.message,
          });
        } else {
          res.status(422).json({
            success: false,
            eventId: event.id,
            endpointId,
            error: 'Event processing failed',
            message: result.message,
          });
        }
      } catch (error) {
        globalLogger.error('[Webhook] Error processing multi-tenant webhook', { error });
        const appErr = Errors.internal();
        res.status(appErr.statusCode).json(appErr.toResponse());
      }
    }
  );

  return router;
}

export default createWebhookRouter;
