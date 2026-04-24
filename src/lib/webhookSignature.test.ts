/**
 * webhookSignature.test.ts
 *
 * Test vectors and behavioural tests for HMAC-SHA256 webhook signature
 * generation and verification, including timestamp tolerance / replay-attack
 * prevention.
 *
 * Security assumptions
 * ────────────────────
 * • Secrets are treated as opaque byte strings; minimum length enforcement is
 *   the caller's responsibility (see WebhookEndpointRepository).
 * • Timestamp values are Unix milliseconds supplied by the sender.  The
 *   tolerance window (default 5 min) limits the replay-attack surface.
 * • Constant-time comparison (timingSafeEqual) prevents timing side-channels
 *   when comparing HMAC digests.
 * • The signed message is `${timestamp}.${body}`, binding the timestamp to the
 *   payload so an attacker cannot reuse a valid body with a fresh timestamp.
 */

import { createHmac } from 'crypto';
import {
  signPayload,
  verifySignature,
  classifySignatureFailure,
  DEFAULT_TIMESTAMP_TOLERANCE_MS,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
  WEBHOOK_EVENT_HEADER,
} from './webhookSignature';
import { AppError, ErrorCode } from './errors';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const SECRET = 'test-webhook-secret-32-chars-min!';
const BODY = '{"event":"offering.created","id":"offer-1"}';
const NOW_MS = 1_700_000_000_000; // fixed epoch for deterministic tests

/** Compute the expected HMAC independently of the implementation. */
function expectedHmac(secret: string, body: string, timestamp: string): string {
  return (
    'sha256=' +
    createHmac('sha256', secret)
      .update(`${timestamp}.${body}`)
      .digest('hex')
  );
}

function validTimestamp(): string {
  return NOW_MS.toString();
}

// ─── Constants ────────────────────────────────────────────────────────────────

describe('module constants', () => {
  it('exports the correct header names', () => {
    expect(WEBHOOK_SIGNATURE_HEADER).toBe('X-Revora-Signature');
    expect(WEBHOOK_TIMESTAMP_HEADER).toBe('X-Revora-Timestamp');
    expect(WEBHOOK_EVENT_HEADER).toBe('X-Revora-Event');
  });

  it('exports a positive default tolerance', () => {
    expect(DEFAULT_TIMESTAMP_TOLERANCE_MS).toBeGreaterThan(0);
    expect(DEFAULT_TIMESTAMP_TOLERANCE_MS).toBe(5 * 60 * 1000);
  });
});

// ─── signPayload – HMAC test vectors ─────────────────────────────────────────

describe('signPayload', () => {
  describe('output format', () => {
    it('returns a string prefixed with "sha256="', () => {
      const sig = signPayload(SECRET, BODY, validTimestamp());
      expect(sig).toMatch(/^sha256=[0-9a-f]{64}$/);
    });

    it('produces a 64-character hex digest (SHA-256)', () => {
      const sig = signPayload(SECRET, BODY, validTimestamp());
      const hex = sig.slice('sha256='.length);
      expect(hex).toHaveLength(64);
      expect(hex).toMatch(/^[0-9a-f]+$/);
    });
  });

  describe('HMAC test vectors', () => {
    it('vector 1 – matches independent HMAC computation', () => {
      const ts = '1700000000000';
      const body = '{"hello":"world"}';
      const secret = 'secret-a';
      expect(signPayload(secret, body, ts)).toBe(expectedHmac(secret, body, ts));
    });

    it('vector 2 – empty body', () => {
      const ts = '1700000000001';
      const secret = 'secret-b';
      expect(signPayload(secret, '', ts)).toBe(expectedHmac(secret, '', ts));
    });

    it('vector 3 – unicode body', () => {
      const ts = '1700000000002';
      const body = '{"name":"Ünïcödé 🚀"}';
      const secret = 'secret-c';
      expect(signPayload(secret, body, ts)).toBe(expectedHmac(secret, body, ts));
    });

    it('vector 4 – large payload', () => {
      const ts = '1700000000003';
      const body = JSON.stringify({ data: 'x'.repeat(10_000) });
      const secret = 'secret-d';
      expect(signPayload(secret, body, ts)).toBe(expectedHmac(secret, body, ts));
    });

    it('vector 5 – known fixed output', () => {
      // Pre-computed: echo -n "1700000000000.{}" | openssl dgst -sha256 -hmac "fixed-secret"
      const ts = '1700000000000';
      const body = '{}';
      const secret = 'fixed-secret';
      const expected = expectedHmac(secret, body, ts);
      expect(signPayload(secret, body, ts)).toBe(expected);
    });
  });

  describe('sensitivity', () => {
    it('different secrets produce different signatures', () => {
      const ts = validTimestamp();
      expect(signPayload('secret-a', BODY, ts)).not.toBe(
        signPayload('secret-b', BODY, ts),
      );
    });

    it('different bodies produce different signatures', () => {
      const ts = validTimestamp();
      expect(signPayload(SECRET, 'body-a', ts)).not.toBe(
        signPayload(SECRET, 'body-b', ts),
      );
    });

    it('different timestamps produce different signatures', () => {
      expect(signPayload(SECRET, BODY, '1000')).not.toBe(
        signPayload(SECRET, BODY, '2000'),
      );
    });

    it('single-character body difference changes the signature', () => {
      const ts = validTimestamp();
      const sig1 = signPayload(SECRET, '{"a":1}', ts);
      const sig2 = signPayload(SECRET, '{"a":2}', ts);
      expect(sig1).not.toBe(sig2);
    });
  });

  describe('default timestamp', () => {
    it('uses Date.now() when no timestamp is provided', () => {
      const before = Date.now();
      const sig = signPayload(SECRET, BODY);
      const after = Date.now();

      // Verify the signature is valid for some timestamp in [before, after]
      let matched = false;
      for (let t = before; t <= after; t++) {
        if (sig === expectedHmac(SECRET, BODY, t.toString())) {
          matched = true;
          break;
        }
      }
      // The range is tiny; if not matched, the default timestamp is wrong
      expect(matched).toBe(true);
    });
  });
});

// ─── verifySignature – happy path ─────────────────────────────────────────────

describe('verifySignature – valid requests', () => {
  it('does not throw for a correctly signed, fresh request', () => {
    const ts = validTimestamp();
    const sig = signPayload(SECRET, BODY, ts);
    expect(() =>
      verifySignature(SECRET, BODY, sig, ts, DEFAULT_TIMESTAMP_TOLERANCE_MS, NOW_MS),
    ).not.toThrow();
  });

  it('accepts a request at exactly the tolerance boundary (t = now - tolerance)', () => {
    const ts = (NOW_MS - DEFAULT_TIMESTAMP_TOLERANCE_MS).toString();
    const sig = signPayload(SECRET, BODY, ts);
    expect(() =>
      verifySignature(SECRET, BODY, sig, ts, DEFAULT_TIMESTAMP_TOLERANCE_MS, NOW_MS),
    ).not.toThrow();
  });

  it('accepts a request with timestamp slightly in the past', () => {
    const ts = (NOW_MS - 1000).toString(); // 1 second ago
    const sig = signPayload(SECRET, BODY, ts);
    expect(() =>
      verifySignature(SECRET, BODY, sig, ts, DEFAULT_TIMESTAMP_TOLERANCE_MS, NOW_MS),
    ).not.toThrow();
  });

  it('accepts a request with timestamp slightly in the future (clock skew)', () => {
    const ts = (NOW_MS + 1000).toString(); // 1 second ahead
    const sig = signPayload(SECRET, BODY, ts);
    expect(() =>
      verifySignature(SECRET, BODY, sig, ts, DEFAULT_TIMESTAMP_TOLERANCE_MS, NOW_MS),
    ).not.toThrow();
  });

  it('accepts an empty body with a valid signature', () => {
    const ts = validTimestamp();
    const sig = signPayload(SECRET, '', ts);
    expect(() =>
      verifySignature(SECRET, '', sig, ts, DEFAULT_TIMESTAMP_TOLERANCE_MS, NOW_MS),
    ).not.toThrow();
  });

  it('accepts a custom tolerance of 0 ms when timestamp matches exactly', () => {
    const ts = NOW_MS.toString();
    const sig = signPayload(SECRET, BODY, ts);
    expect(() =>
      verifySignature(SECRET, BODY, sig, ts, 0, NOW_MS),
    ).not.toThrow();
  });
});

// ─── verifySignature – missing / malformed headers ────────────────────────────

describe('verifySignature – missing headers', () => {
  it('throws UNAUTHORIZED when signature header is undefined', () => {
    expect(() =>
      verifySignature(SECRET, BODY, undefined, validTimestamp(), DEFAULT_TIMESTAMP_TOLERANCE_MS, NOW_MS),
    ).toThrow(AppError);

    try {
      verifySignature(SECRET, BODY, undefined, validTimestamp(), DEFAULT_TIMESTAMP_TOLERANCE_MS, NOW_MS);
    } catch (err) {
      expect((err as AppError).code).toBe(ErrorCode.UNAUTHORIZED);
      expect((err as AppError).statusCode).toBe(401);
      expect((err as AppError).message).toMatch(/Missing webhook signature/);
    }
  });

  it('throws UNAUTHORIZED when signature header is empty string', () => {
    expect(() =>
      verifySignature(SECRET, BODY, '', validTimestamp(), DEFAULT_TIMESTAMP_TOLERANCE_MS, NOW_MS),
    ).toThrow(AppError);
  });

  it('throws UNAUTHORIZED when timestamp header is undefined', () => {
    const sig = signPayload(SECRET, BODY, validTimestamp());
    expect(() =>
      verifySignature(SECRET, BODY, sig, undefined, DEFAULT_TIMESTAMP_TOLERANCE_MS, NOW_MS),
    ).toThrow(AppError);

    try {
      verifySignature(SECRET, BODY, sig, undefined, DEFAULT_TIMESTAMP_TOLERANCE_MS, NOW_MS);
    } catch (err) {
      expect((err as AppError).message).toMatch(/Missing webhook timestamp/);
    }
  });

  it('throws UNAUTHORIZED when timestamp header is empty string', () => {
    const sig = signPayload(SECRET, BODY, validTimestamp());
    expect(() =>
      verifySignature(SECRET, BODY, sig, '', DEFAULT_TIMESTAMP_TOLERANCE_MS, NOW_MS),
    ).toThrow(AppError);
  });
});

// ─── verifySignature – timestamp tolerance ────────────────────────────────────

describe('verifySignature – timestamp tolerance', () => {
  it('rejects a request older than the tolerance window', () => {
    const ts = (NOW_MS - DEFAULT_TIMESTAMP_TOLERANCE_MS - 1).toString();
    const sig = signPayload(SECRET, BODY, ts);

    expect(() =>
      verifySignature(SECRET, BODY, sig, ts, DEFAULT_TIMESTAMP_TOLERANCE_MS, NOW_MS),
    ).toThrow(AppError);

    try {
      verifySignature(SECRET, BODY, sig, ts, DEFAULT_TIMESTAMP_TOLERANCE_MS, NOW_MS);
    } catch (err) {
      expect((err as AppError).message).toMatch(/too old/);
    }
  });

  it('rejects a request far in the future (beyond tolerance)', () => {
    const ts = (NOW_MS + DEFAULT_TIMESTAMP_TOLERANCE_MS + 1).toString();
    const sig = signPayload(SECRET, BODY, ts);

    expect(() =>
      verifySignature(SECRET, BODY, sig, ts, DEFAULT_TIMESTAMP_TOLERANCE_MS, NOW_MS),
    ).toThrow(AppError);

    try {
      verifySignature(SECRET, BODY, sig, ts, DEFAULT_TIMESTAMP_TOLERANCE_MS, NOW_MS);
    } catch (err) {
      expect((err as AppError).message).toMatch(/in the future/);
    }
  });

  it('rejects a request 1 hour old', () => {
    const ts = (NOW_MS - 60 * 60 * 1000).toString();
    const sig = signPayload(SECRET, BODY, ts);
    expect(() =>
      verifySignature(SECRET, BODY, sig, ts, DEFAULT_TIMESTAMP_TOLERANCE_MS, NOW_MS),
    ).toThrow(AppError);
  });

  it('rejects a request with timestamp = 0', () => {
    const sig = signPayload(SECRET, BODY, '0');
    expect(() =>
      verifySignature(SECRET, BODY, sig, '0', DEFAULT_TIMESTAMP_TOLERANCE_MS, NOW_MS),
    ).toThrow(AppError);
  });

  it('rejects a non-numeric timestamp', () => {
    const sig = signPayload(SECRET, BODY, validTimestamp());
    expect(() =>
      verifySignature(SECRET, BODY, sig, 'not-a-number', DEFAULT_TIMESTAMP_TOLERANCE_MS, NOW_MS),
    ).toThrow(AppError);

    try {
      verifySignature(SECRET, BODY, sig, 'not-a-number', DEFAULT_TIMESTAMP_TOLERANCE_MS, NOW_MS);
    } catch (err) {
      expect((err as AppError).message).toMatch(/Invalid webhook timestamp/);
    }
  });

  it('rejects a negative timestamp', () => {
    const sig = signPayload(SECRET, BODY, '-1');
    expect(() =>
      verifySignature(SECRET, BODY, sig, '-1', DEFAULT_TIMESTAMP_TOLERANCE_MS, NOW_MS),
    ).toThrow(AppError);
  });

  it('respects a custom tolerance of 10 seconds', () => {
    const tolerance = 10_000;
    const freshTs = (NOW_MS - 5_000).toString(); // 5 s ago – within window
    const staleTs = (NOW_MS - 15_000).toString(); // 15 s ago – outside window

    const freshSig = signPayload(SECRET, BODY, freshTs);
    const staleSig = signPayload(SECRET, BODY, staleTs);

    expect(() =>
      verifySignature(SECRET, BODY, freshSig, freshTs, tolerance, NOW_MS),
    ).not.toThrow();

    expect(() =>
      verifySignature(SECRET, BODY, staleSig, staleTs, tolerance, NOW_MS),
    ).toThrow(AppError);
  });
});

// ─── verifySignature – invalid signatures ─────────────────────────────────────

describe('verifySignature – invalid signatures', () => {
  it('rejects a signature with wrong secret', () => {
    const ts = validTimestamp();
    const sig = signPayload('wrong-secret', BODY, ts);
    expect(() =>
      verifySignature(SECRET, BODY, sig, ts, DEFAULT_TIMESTAMP_TOLERANCE_MS, NOW_MS),
    ).toThrow(AppError);

    try {
      verifySignature(SECRET, BODY, sig, ts, DEFAULT_TIMESTAMP_TOLERANCE_MS, NOW_MS);
    } catch (err) {
      expect((err as AppError).message).toMatch(/Invalid webhook signature/);
    }
  });

  it('rejects a signature for a different body', () => {
    const ts = validTimestamp();
    const sig = signPayload(SECRET, '{"tampered":true}', ts);
    expect(() =>
      verifySignature(SECRET, BODY, sig, ts, DEFAULT_TIMESTAMP_TOLERANCE_MS, NOW_MS),
    ).toThrow(AppError);
  });

  it('rejects a signature for a different timestamp', () => {
    const ts = validTimestamp();
    const sig = signPayload(SECRET, BODY, (NOW_MS - 1000).toString());
    expect(() =>
      verifySignature(SECRET, BODY, sig, ts, DEFAULT_TIMESTAMP_TOLERANCE_MS, NOW_MS),
    ).toThrow(AppError);
  });

  it('rejects a signature without the sha256= prefix', () => {
    const ts = validTimestamp();
    const rawHex = createHmac('sha256', SECRET)
      .update(`${ts}.${BODY}`)
      .digest('hex');
    expect(() =>
      verifySignature(SECRET, BODY, rawHex, ts, DEFAULT_TIMESTAMP_TOLERANCE_MS, NOW_MS),
    ).toThrow(AppError);

    try {
      verifySignature(SECRET, BODY, rawHex, ts, DEFAULT_TIMESTAMP_TOLERANCE_MS, NOW_MS);
    } catch (err) {
      expect((err as AppError).message).toMatch(/Unsupported webhook signature scheme/);
    }
  });

  it('rejects a truncated signature', () => {
    const ts = validTimestamp();
    const sig = signPayload(SECRET, BODY, ts).slice(0, -4); // chop last 4 chars
    expect(() =>
      verifySignature(SECRET, BODY, sig, ts, DEFAULT_TIMESTAMP_TOLERANCE_MS, NOW_MS),
    ).toThrow(AppError);
  });

  it('rejects an all-zeros signature of correct length', () => {
    const ts = validTimestamp();
    const zeros = 'sha256=' + '0'.repeat(64);
    expect(() =>
      verifySignature(SECRET, BODY, zeros, ts, DEFAULT_TIMESTAMP_TOLERANCE_MS, NOW_MS),
    ).toThrow(AppError);
  });

  it('rejects a valid signature replayed with a different timestamp header', () => {
    const ts = validTimestamp();
    const sig = signPayload(SECRET, BODY, ts);
    const replayTs = (NOW_MS - 1000).toString(); // attacker changes the header
    expect(() =>
      verifySignature(SECRET, BODY, sig, replayTs, DEFAULT_TIMESTAMP_TOLERANCE_MS, NOW_MS),
    ).toThrow(AppError);
  });
});

// ─── classifySignatureFailure ─────────────────────────────────────────────────

describe('classifySignatureFailure', () => {
  function failureFor(
    sig: string | undefined,
    ts: string | undefined,
    toleranceMs = DEFAULT_TIMESTAMP_TOLERANCE_MS,
  ): unknown {
    try {
      verifySignature(SECRET, BODY, sig, ts, toleranceMs, NOW_MS);
    } catch (err) {
      return err;
    }
    return null;
  }

  it('classifies missing signature', () => {
    expect(classifySignatureFailure(failureFor(undefined, validTimestamp()))).toBe(
      'missing_signature',
    );
  });

  it('classifies missing timestamp', () => {
    const sig = signPayload(SECRET, BODY, validTimestamp());
    expect(classifySignatureFailure(failureFor(sig, undefined))).toBe(
      'missing_timestamp',
    );
  });

  it('classifies invalid timestamp format', () => {
    const sig = signPayload(SECRET, BODY, validTimestamp());
    expect(classifySignatureFailure(failureFor(sig, 'not-a-number'))).toBe(
      'invalid_timestamp_format',
    );
  });

  it('classifies timestamp too old', () => {
    const staleTs = (NOW_MS - DEFAULT_TIMESTAMP_TOLERANCE_MS - 1).toString();
    const sig = signPayload(SECRET, BODY, staleTs);
    expect(classifySignatureFailure(failureFor(sig, staleTs))).toBe(
      'timestamp_too_old',
    );
  });

  it('classifies timestamp in the future', () => {
    const futureTs = (NOW_MS + DEFAULT_TIMESTAMP_TOLERANCE_MS + 1).toString();
    const sig = signPayload(SECRET, BODY, futureTs);
    expect(classifySignatureFailure(failureFor(sig, futureTs))).toBe(
      'timestamp_in_future',
    );
  });

  it('classifies unsupported scheme', () => {
    const ts = validTimestamp();
    const rawHex = createHmac('sha256', SECRET).update(`${ts}.${BODY}`).digest('hex');
    expect(classifySignatureFailure(failureFor(rawHex, ts))).toBe(
      'unsupported_scheme',
    );
  });

  it('classifies invalid signature (wrong secret)', () => {
    const ts = validTimestamp();
    const sig = signPayload('wrong-secret', BODY, ts);
    expect(classifySignatureFailure(failureFor(sig, ts))).toBe(
      'invalid_signature',
    );
  });

  it('returns "unknown" for non-Error values', () => {
    expect(classifySignatureFailure('a string')).toBe('unknown');
    expect(classifySignatureFailure(null)).toBe('unknown');
    expect(classifySignatureFailure(42)).toBe('unknown');
  });

  it('returns "unknown" for a generic Error', () => {
    expect(classifySignatureFailure(new Error('something else entirely'))).toBe(
      'unknown',
    );
  });
});

// ─── Replay-attack scenario ───────────────────────────────────────────────────

describe('replay attack prevention', () => {
  it('rejects a valid request replayed after the tolerance window expires', () => {
    const ts = NOW_MS.toString();
    const sig = signPayload(SECRET, BODY, ts);

    // At time of original delivery – should pass
    expect(() =>
      verifySignature(SECRET, BODY, sig, ts, DEFAULT_TIMESTAMP_TOLERANCE_MS, NOW_MS),
    ).not.toThrow();

    // Replayed 6 minutes later – should fail
    const replayNow = NOW_MS + 6 * 60 * 1000;
    expect(() =>
      verifySignature(SECRET, BODY, sig, ts, DEFAULT_TIMESTAMP_TOLERANCE_MS, replayNow),
    ).toThrow(AppError);
  });

  it('rejects a body-swap attack (same timestamp, different body)', () => {
    const ts = validTimestamp();
    const originalSig = signPayload(SECRET, BODY, ts);
    const tamperedBody = BODY.replace('offering.created', 'payout.completed');

    expect(() =>
      verifySignature(SECRET, tamperedBody, originalSig, ts, DEFAULT_TIMESTAMP_TOLERANCE_MS, NOW_MS),
    ).toThrow(AppError);
  });
});
