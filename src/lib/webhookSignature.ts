import { createHmac, timingSafeEqual } from 'crypto';
import { Errors } from './errors';

/**
 * Default tolerance window for webhook timestamp validation.
 * Requests older than this are rejected to prevent replay attacks.
 */
export const DEFAULT_TIMESTAMP_TOLERANCE_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Header names sent with every outbound webhook delivery.
 */
export const WEBHOOK_SIGNATURE_HEADER = 'X-Revora-Signature';
export const WEBHOOK_TIMESTAMP_HEADER = 'X-Revora-Timestamp';
export const WEBHOOK_EVENT_HEADER = 'X-Revora-Event';

/**
 * Signs a webhook payload body with HMAC-SHA256.
 *
 * The signed message is `${timestamp}.${body}` so that the timestamp is
 * cryptographically bound to the payload, preventing replay attacks where an
 * attacker replays a valid body with a fresh timestamp.
 *
 * Returns a string of the form `sha256=<hex>`.
 *
 * @param secret    - Shared secret for the endpoint.
 * @param body      - Raw JSON string of the webhook payload.
 * @param timestamp - ISO-8601 or Unix-ms timestamp string included in the
 *                    signed message.  Defaults to `Date.now().toString()`.
 */
export function signPayload(
  secret: string,
  body: string,
  timestamp: string = Date.now().toString(),
): string {
  const message = `${timestamp}.${body}`;
  return 'sha256=' + createHmac('sha256', secret).update(message).digest('hex');
}

/**
 * Verifies an inbound webhook signature.
 *
 * Performs a constant-time comparison to prevent timing-based side-channel
 * attacks.  Throws an `AppError` (UNAUTHORIZED, 401) on any failure so the
 * caller can forward it directly to Express's error handler.
 *
 * @param secret           - Shared secret for the endpoint.
 * @param body             - Raw request body string.
 * @param signature        - Value of the `X-Revora-Signature` header.
 * @param timestamp        - Value of the `X-Revora-Timestamp` header (ms since epoch).
 * @param toleranceMs      - Maximum age of a valid request in milliseconds.
 * @param nowMs            - Current time in ms (injectable for testing).
 *
 * @throws AppError UNAUTHORIZED if signature is missing, malformed, expired, or invalid.
 */
export function verifySignature(
  secret: string,
  body: string,
  signature: string | undefined,
  timestamp: string | undefined,
  toleranceMs: number = DEFAULT_TIMESTAMP_TOLERANCE_MS,
  nowMs: number = Date.now(),
): void {
  // ── 1. Presence checks ────────────────────────────────────────────────────
  if (!signature) {
    throw Errors.unauthorized('Missing webhook signature header');
  }
  if (!timestamp) {
    throw Errors.unauthorized('Missing webhook timestamp header');
  }

  // ── 2. Timestamp format ───────────────────────────────────────────────────
  const tsNum = Number(timestamp);
  if (!Number.isFinite(tsNum) || tsNum <= 0) {
    throw Errors.unauthorized('Invalid webhook timestamp');
  }

  // ── 3. Timestamp tolerance (replay-attack window) ─────────────────────────
  const ageMs = nowMs - tsNum;
  if (ageMs > toleranceMs) {
    throw Errors.unauthorized('Webhook timestamp too old');
  }
  if (ageMs < -toleranceMs) {
    throw Errors.unauthorized('Webhook timestamp is in the future');
  }

  // ── 4. Signature format ───────────────────────────────────────────────────
  if (!signature.startsWith('sha256=')) {
    throw Errors.unauthorized('Unsupported webhook signature scheme');
  }

  // ── 5. Constant-time HMAC comparison ─────────────────────────────────────
  const expected = signPayload(secret, body, timestamp);

  let sigBuf: Buffer;
  let expectedBuf: Buffer;
  try {
    sigBuf = Buffer.from(signature, 'utf8');
    expectedBuf = Buffer.from(expected, 'utf8');
  } catch {
    throw Errors.unauthorized('Invalid webhook signature encoding');
  }

  // Buffers must be the same length for timingSafeEqual; length mismatch is
  // itself a safe early-exit because it reveals no secret information.
  if (sigBuf.length !== expectedBuf.length) {
    throw Errors.unauthorized('Invalid webhook signature');
  }

  if (!timingSafeEqual(sigBuf, expectedBuf)) {
    throw Errors.unauthorized('Invalid webhook signature');
  }
}

/**
 * Classifies a webhook signature verification failure for structured logging.
 *
 * Returns a short machine-readable reason string so callers can emit
 * consistent log fields without parsing error messages.
 */
export type SignatureFailureReason =
  | 'missing_signature'
  | 'missing_timestamp'
  | 'invalid_timestamp_format'
  | 'timestamp_too_old'
  | 'timestamp_in_future'
  | 'unsupported_scheme'
  | 'invalid_signature'
  | 'unknown';

export function classifySignatureFailure(err: unknown): SignatureFailureReason {
  if (!(err instanceof Error)) return 'unknown';
  const msg = err.message;
  if (msg.includes('Missing webhook signature')) return 'missing_signature';
  if (msg.includes('Missing webhook timestamp')) return 'missing_timestamp';
  if (msg.includes('Invalid webhook timestamp') && msg.includes('format')) return 'invalid_timestamp_format';
  if (msg.includes('Invalid webhook timestamp')) return 'invalid_timestamp_format';
  if (msg.includes('too old')) return 'timestamp_too_old';
  if (msg.includes('in the future')) return 'timestamp_in_future';
  if (msg.includes('Unsupported webhook signature scheme')) return 'unsupported_scheme';
  if (msg.includes('Invalid webhook signature')) return 'invalid_signature';
  return 'unknown';
}
