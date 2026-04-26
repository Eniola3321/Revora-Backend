import {
  classifyStellarRPCFailure,
  StellarRPCFailureClass,
} from './stellarRpcFailure';

describe('classifyStellarRPCFailure', () => {
  it('classifies timeout-shaped failures', () => {
    expect(
      classifyStellarRPCFailure(new Error('upstream timeout while reading horizon')),
    ).toBe(StellarRPCFailureClass.TIMEOUT);
  });

  it('classifies upstream status failures', () => {
    expect(classifyStellarRPCFailure({ status: 429 })).toBe(
      StellarRPCFailureClass.RATE_LIMIT,
    );
    expect(classifyStellarRPCFailure({ status: 401 })).toBe(
      StellarRPCFailureClass.UNAUTHORIZED,
    );
    expect(classifyStellarRPCFailure({ status: 503 })).toBe(
      StellarRPCFailureClass.UPSTREAM_ERROR,
    );
  });

  it('classifies malformed payload failures', () => {
    expect(classifyStellarRPCFailure(new SyntaxError('bad json'))).toBe(
      StellarRPCFailureClass.MALFORMED_RESPONSE,
    );
  });

  it('falls back to UNKNOWN for everything else', () => {
    expect(classifyStellarRPCFailure('oops')).toBe(StellarRPCFailureClass.UNKNOWN);
  });
});
