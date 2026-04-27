import {
  classifyStellarRPCFailure,
  createStellarErrorResponse,
  isStellarRPCRetryable,
  shouldRetryStellarRPCFailure,
  StellarRPCFailureClass,
} from "./stellarRpcFailure";

describe("classifyStellarRPCFailure", () => {
  const context = {
    operation: "test_operation",
    attemptCount: 1,
  };

  it("classifies timeout-shaped failures", () => {
    const result = classifyStellarRPCFailure(
      new Error("upstream timeout while reading horizon"),
      context,
    );
    expect(result.class).toBe(StellarRPCFailureClass.TIMEOUT);
    expect(result.shouldRetry).toBe(true);
    expect(result.context).toEqual(context);
    expect(result.timestamp).toBeDefined();
  });

  it("classifies abort errors as timeout", () => {
    const error = new Error("Request aborted");
    error.name = "AbortError";
    const result = classifyStellarRPCFailure(error, context);
    expect(result.class).toBe(StellarRPCFailureClass.TIMEOUT);
    expect(result.shouldRetry).toBe(true);
  });

  it("classifies network connectivity errors", () => {
    const networkError = new Error("Network connection failed");
    networkError.name = "NetworkError";
    const result = classifyStellarRPCFailure(networkError, context);
    expect(result.class).toBe(StellarRPCFailureClass.NETWORK_ERROR);
    expect(result.shouldRetry).toBe(true);
  });

  it("classifies fetch errors as network errors", () => {
    const fetchError = new Error("Fetch failed");
    fetchError.name = "FetchError";
    const result = classifyStellarRPCFailure(fetchError, context);
    expect(result.class).toBe(StellarRPCFailureClass.NETWORK_ERROR);
    expect(result.shouldRetry).toBe(true);
  });

  it("classifies ECONNREFUSED errors as network errors", () => {
    const result = classifyStellarRPCFailure(
      new Error("ECONNREFUSED"),
      context,
    );
    expect(result.class).toBe(StellarRPCFailureClass.NETWORK_ERROR);
  });

  it("classifies ENOTFOUND errors as network errors", () => {
    const result = classifyStellarRPCFailure(new Error("ENOTFOUND"), context);
    expect(result.class).toBe(StellarRPCFailureClass.NETWORK_ERROR);
  });

  it("classifies upstream status failures", () => {
    const rateLimitResult = classifyStellarRPCFailure({ status: 429 }, context);
    expect(rateLimitResult.class).toBe(StellarRPCFailureClass.RATE_LIMIT);
    expect(rateLimitResult.shouldRetry).toBe(true);

    const unauthorizedResult = classifyStellarRPCFailure(
      { status: 401 },
      context,
    );
    expect(unauthorizedResult.class).toBe(StellarRPCFailureClass.UNAUTHORIZED);
    expect(unauthorizedResult.shouldRetry).toBe(false);

    const forbiddenResult = classifyStellarRPCFailure({ status: 403 }, context);
    expect(forbiddenResult.class).toBe(StellarRPCFailureClass.UNAUTHORIZED);
    expect(forbiddenResult.shouldRetry).toBe(false);

    const upstreamResult = classifyStellarRPCFailure({ status: 503 }, context);
    expect(upstreamResult.class).toBe(StellarRPCFailureClass.UPSTREAM_ERROR);
    expect(upstreamResult.shouldRetry).toBe(true);
  });

  it("classifies Horizon operation result codes", () => {
    const error = {
      status: 400,
      extras: {
        result_codes: {
          transaction: "tx_failed",
          operations: ["op_no_destination"],
        },
      },
    };
    const result = classifyStellarRPCFailure(error, context);
    expect(result.class).toBe(StellarRPCFailureClass.OP_RESULT_CODE);
    expect(result.shouldRetry).toBe(false);
  });

  it("classifies Horizon transaction result codes", () => {
    const error = {
      status: 400,
      extras: {
        result_codes: {
          transaction: "tx_bad_seq",
          operations: [],
        },
      },
    };
    const result = classifyStellarRPCFailure(error, context);
    expect(result.class).toBe(StellarRPCFailureClass.TX_RESULT_CODE);
    expect(result.shouldRetry).toBe(false);
  });

  it("classifies Soroban contract errors", () => {
    const contractError = {
      code: "CONTRACT_ERROR",
      message: "Contract execution failed",
    };
    const result = classifyStellarRPCFailure(contractError, context);
    expect(result.class).toBe(StellarRPCFailureClass.CONTRACT_ERROR);
    expect(result.shouldRetry).toBe(false);
  });

  it("classifies transaction failed errors", () => {
    const txError = {
      code: "TRANSACTION_FAILED",
      result_xdr: "tx_failed",
    };
    const result = classifyStellarRPCFailure(txError, context);
    expect(result.class).toBe(StellarRPCFailureClass.TRANSACTION_FAILED);
    expect(result.shouldRetry).toBe(false);
  });

  it("classifies insufficient funds errors", () => {
    const fundsError = {
      code: "INSUFFICIENT_FUNDS",
      message: "Insufficient balance",
    };
    const result = classifyStellarRPCFailure(fundsError, context);
    expect(result.class).toBe(StellarRPCFailureClass.INSUFFICIENT_FUNDS);
    expect(result.shouldRetry).toBe(false);
  });

  it("classifies bad sequence errors", () => {
    const seqError = {
      code: "BAD_SEQUENCE",
      message: "Bad sequence number",
    };
    const result = classifyStellarRPCFailure(seqError, context);
    expect(result.class).toBe(StellarRPCFailureClass.BAD_SEQUENCE);
    expect(result.shouldRetry).toBe(true);
  });

  it("classifies signing errors", () => {
    const signingError = {
      code: "SIGNING_ERROR",
      message: "Invalid signature",
    };
    const result = classifyStellarRPCFailure(signingError, context);
    expect(result.class).toBe(StellarRPCFailureClass.SIGNING_ERROR);
    expect(result.shouldRetry).toBe(false);
  });

  it("classifies malformed payload failures", () => {
    const result = classifyStellarRPCFailure(
      new SyntaxError("bad json"),
      context,
    );
    expect(result.class).toBe(StellarRPCFailureClass.MALFORMED_RESPONSE);
    expect(result.shouldRetry).toBe(true);
  });

  it("falls back to UNKNOWN for everything else", () => {
    const result = classifyStellarRPCFailure("oops", context);
    expect(result.class).toBe(StellarRPCFailureClass.UNKNOWN);
    expect(result.shouldRetry).toBe(true);
  });

  it("sanitizes error objects to prevent data leakage", () => {
    const error = new Error("Sensitive data: password=secret123");
    const result = classifyStellarRPCFailure(error, context);
    expect(result.originalError).toHaveProperty("name");
    expect(result.originalError).toHaveProperty("message");
    expect((result.originalError as any).stack).toBeUndefined();
  });

  it("increases retry delay with attempt count for timeouts", () => {
    const context1 = { operation: "test", attemptCount: 1 };
    const result1 = classifyStellarRPCFailure(new Error("timeout"), context1);
    expect(result1.suggestedRetryDelayMs).toBeLessThanOrEqual(1000);

    const context2 = { operation: "test", attemptCount: 2 };
    const result2 = classifyStellarRPCFailure(new Error("timeout"), context2);
    expect(result2.suggestedRetryDelayMs).toBeLessThanOrEqual(2000);
  });
});

describe("shouldRetryStellarRPCFailure", () => {
  const context = { operation: "test" };

  it("returns false for non-retryable classes", () => {
    const nonRetryableFailure = {
      class: StellarRPCFailureClass.SIGNING_ERROR,
      context,
      originalError: {},
      timestamp: new Date().toISOString(),
      shouldRetry: false,
    };
    expect(shouldRetryStellarRPCFailure(nonRetryableFailure)).toBe(false);
  });

  it("returns false when max attempts exceeded", () => {
    const failure = {
      class: StellarRPCFailureClass.TIMEOUT,
      context: { operation: "test", attemptCount: 5 },
      originalError: {},
      timestamp: new Date().toISOString(),
      shouldRetry: true,
    };
    expect(shouldRetryStellarRPCFailure(failure, 3)).toBe(false);
  });

  it("returns true for retryable failures within max attempts", () => {
    const failure = {
      class: StellarRPCFailureClass.TIMEOUT,
      context: { operation: "test", attemptCount: 1 },
      originalError: {},
      timestamp: new Date().toISOString(),
      shouldRetry: true,
    };
    expect(shouldRetryStellarRPCFailure(failure, 3)).toBe(true);
  });
});

describe("createStellarErrorResponse", () => {
  it("creates standardized error response", () => {
    const failure = {
      class: StellarRPCFailureClass.TIMEOUT,
      context: { operation: "getAccount" },
      originalError: {},
      timestamp: "2024-01-01T00:00:00Z",
      shouldRetry: true,
      suggestedRetryDelayMs: 1000,
    };
    const response = createStellarErrorResponse(failure, "req-123");
    expect(response.code).toBe("STELLAR_TIMEOUT");
    expect(response.message).toBe("Stellar network request timed out");
    expect(response.details.operation).toBe("getAccount");
    expect(response.details.retryable).toBe(true);
    expect(response.details.retryDelayMs).toBe(1000);
    expect(response.requestId).toBe("req-123");
  });

  it("handles unknown failure classes", () => {
    const failure = {
      class: StellarRPCFailureClass.UNKNOWN,
      context: { operation: "test" },
      originalError: {},
      timestamp: "2024-01-01T00:00:00Z",
      shouldRetry: false,
    };
    const response = createStellarErrorResponse(failure);
    expect(response.code).toBe("STELLAR_UNKNOWN");
    expect(response.message).toBe("Unknown Stellar network error");
  });
});

describe("isStellarRPCRetryable", () => {
  it("returns true for TIMEOUT", () => {
    expect(isStellarRPCRetryable(StellarRPCFailureClass.TIMEOUT)).toBe(true);
  });

  it("returns true for UPSTREAM_ERROR", () => {
    expect(isStellarRPCRetryable(StellarRPCFailureClass.UPSTREAM_ERROR)).toBe(
      true,
    );
  });

  it("returns false for other classes", () => {
    expect(isStellarRPCRetryable(StellarRPCFailureClass.RATE_LIMIT)).toBe(
      false,
    );
    expect(isStellarRPCRetryable(StellarRPCFailureClass.UNAUTHORIZED)).toBe(
      false,
    );
    expect(isStellarRPCRetryable(StellarRPCFailureClass.TX_RESULT_CODE)).toBe(
      false,
    );
    expect(isStellarRPCRetryable(StellarRPCFailureClass.OP_RESULT_CODE)).toBe(
      false,
    );
  });
});
