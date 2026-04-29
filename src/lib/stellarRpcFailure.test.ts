import {
  classifyStellarRPCFailure,
  StellarRPCFailureClass,
} from './stellarRpcFailure';

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
