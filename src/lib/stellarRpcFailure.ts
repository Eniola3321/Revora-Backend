/**
 * @dev Stable classification for failures returned by Stellar-facing dependencies.
 * Raw upstream messages must never cross the API trust boundary.
 */
export enum StellarRPCFailureClass {
  TIMEOUT = 'TIMEOUT',
  RATE_LIMIT = 'RATE_LIMIT',
  UPSTREAM_ERROR = 'UPSTREAM_ERROR',
  MALFORMED_RESPONSE = 'MALFORMED_RESPONSE',
  UNAUTHORIZED = 'UNAUTHORIZED',
  /** Transaction-level result code from Horizon (e.g. tx_bad_seq, tx_insufficient_fee). */
  TX_RESULT_CODE = 'TX_RESULT_CODE',
  /** Operation-level result code from Horizon (e.g. op_no_destination, op_underfunded). */
  OP_RESULT_CODE = 'OP_RESULT_CODE',
  UNKNOWN = 'UNKNOWN',
}

/**
 * @dev Horizon transaction-level result codes that indicate a non-retryable
 * protocol error.  Keeping these as a const set avoids string-matching on
 * arbitrary upstream messages.
 *
 * Reference: https://developers.stellar.org/docs/data/horizon/api-reference/errors/result-codes/transactions
 */
export const STELLAR_TX_RESULT_CODES = new Set([
  'tx_failed',
  'tx_too_early',
  'tx_too_late',
  'tx_missing_operation',
  'tx_bad_seq',
  'tx_bad_auth',
  'tx_insufficient_balance',
  'tx_no_source_account',
  'tx_insufficient_fee',
  'tx_bad_auth_extra',
  'tx_internal_error',
]);

/**
 * @dev Horizon operation-level result codes.
 *
 * Reference: https://developers.stellar.org/docs/data/horizon/api-reference/errors/result-codes/operations
 */
export const STELLAR_OP_RESULT_CODES = new Set([
  'op_inner',
  'op_bad_auth',
  'op_no_account',
  'op_not_supported',
  'op_too_many_subentries',
  'op_exceeded_work_limit',
  'op_too_many_sponsoring',
  // payment-specific
  'op_no_destination',
  'op_no_trust',
  'op_not_authorized',
  'op_underfunded',
  'op_src_no_trust',
  'op_src_not_authorized',
  'op_line_full',
  'op_no_issuer',
]);

/**
 * @dev Maps arbitrary dependency failures into deterministic, client-safe buckets.
 *
 * Stellar Horizon 400 responses carry a `extras.result_codes` object with
 * `transaction` and `operations` arrays.  These are classified into
 * TX_RESULT_CODE / OP_RESULT_CODE so callers can decide retry eligibility
 * without inspecting raw upstream strings.
 */
export function classifyStellarRPCFailure(error: unknown): StellarRPCFailureClass {
  if (
    error instanceof Error &&
    (error.name === 'AbortError' || error.message.toLowerCase().includes('timeout'))
  ) {
    return StellarRPCFailureClass.TIMEOUT;
  }

  if (typeof error === 'object' && error !== null) {
    const err = error as Record<string, unknown>;
    const status = err['status'] as number | undefined;

    // ── Stellar Horizon result-code envelope ────────────────────────────────
    // Horizon wraps protocol errors in { extras: { result_codes: { transaction, operations } } }
    const extras = err['extras'] as Record<string, unknown> | undefined;
    const resultCodes = extras?.['result_codes'] as Record<string, unknown> | undefined;

    if (resultCodes) {
      const txCode = resultCodes['transaction'] as string | undefined;
      const opCodes = resultCodes['operations'] as string[] | undefined;

      // Operation-level codes take precedence for actionability
      if (Array.isArray(opCodes) && opCodes.some((c) => STELLAR_OP_RESULT_CODES.has(c))) {
        return StellarRPCFailureClass.OP_RESULT_CODE;
      }
      if (typeof txCode === 'string' && STELLAR_TX_RESULT_CODES.has(txCode)) {
        return StellarRPCFailureClass.TX_RESULT_CODE;
      }
    }

    // ── HTTP status codes ───────────────────────────────────────────────────
    if (status === 429) return StellarRPCFailureClass.RATE_LIMIT;
    if (status === 401 || status === 403) return StellarRPCFailureClass.UNAUTHORIZED;
    if (typeof status === 'number' && status >= 500) return StellarRPCFailureClass.UPSTREAM_ERROR;
  }

  if (error instanceof SyntaxError) {
    return StellarRPCFailureClass.MALFORMED_RESPONSE;
  }

  return StellarRPCFailureClass.UNKNOWN;
}

/**
 * @dev Returns true for failure classes that are safe to retry (transient).
 * TX_RESULT_CODE and OP_RESULT_CODE are protocol errors — retrying them
 * without fixing the transaction will always fail.
 */
export function isStellarRPCRetryable(cls: StellarRPCFailureClass): boolean {
  return cls === StellarRPCFailureClass.TIMEOUT || cls === StellarRPCFailureClass.UPSTREAM_ERROR;
}
