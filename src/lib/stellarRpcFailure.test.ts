import {
  classifyStellarRPCFailure,
  createStellarErrorResponse,
  isStellarRPCRetryable,
  shouldRetryStellarRPCFailure,
  StellarRPCFailureClass,
} from "./stellarRpcFailure";

describe('classifyStellarRPCFailure', () => {
  const mockContext = { operation: 'test' };

  it('classifies timeout-shaped failures', () => {
    const failure = classifyStellarRPCFailure(new Error('upstream timeout while reading horizon'), mockContext);
    expect(failure.class).toBe(StellarRPCFailureClass.TIMEOUT);
    expect(failure.shouldRetry).toBe(true);
  });

  it('classifies upstream status failures', () => {
    expect(classifyStellarRPCFailure({ status: 429 }, mockContext).class).toBe(
      StellarRPCFailureClass.RATE_LIMIT,
    );
    expect(classifyStellarRPCFailure({ status: 401 }, mockContext).class).toBe(
      StellarRPCFailureClass.UNAUTHORIZED,
    );
    expect(classifyStellarRPCFailure({ status: 503 }, mockContext).class).toBe(
      StellarRPCFailureClass.UPSTREAM_ERROR,
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

  it('classifies malformed payload failures', () => {
    expect(classifyStellarRPCFailure(new SyntaxError('bad json'), mockContext).class).toBe(
      StellarRPCFailureClass.MALFORMED_RESPONSE,
    );
  });

  it('falls back to UNKNOWN for everything else', () => {
    expect(classifyStellarRPCFailure('oops', mockContext).class).toBe(StellarRPCFailureClass.UNKNOWN);
  });
});
