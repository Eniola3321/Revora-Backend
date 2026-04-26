import { NextFunction, Request, Response } from 'express';
import { createRegisterHandler } from './registerHandler';
import { DuplicateEmailError, RegisterService } from './registerService';
import { RegisteredUser } from './types';
import { AppError, ErrorCode, UniqueConstraintError } from '../../lib/errors';

// ─── Mock RegisterService ─────────────────────────────────────────────────────

class MockRegisterService {
  result: RegisteredUser | null = null;
  shouldThrow: unknown = null;
  async register(_email: string, _password: string): Promise<RegisteredUser> {
    if (this.shouldThrow) throw this.shouldThrow;
    return this.result!;
  }
}

function makeReq(body: unknown = {}): Request {
  return { body } as unknown as Request;
}

function makeRes() {
  let statusCode = 200;
  let body: unknown = null;
  const res = {
    status(code: number) { statusCode = code; return res; },
    json(obj: unknown) { body = obj; return res; },
    _status: () => statusCode,
    _body: () => body,
  };
  return res as unknown as Response & { _status(): number; _body(): unknown };
}

function makeUser(overrides: Partial<RegisteredUser> = {}): RegisteredUser {
  return { id: 'user-1', email: 'investor@example.com', role: 'investor', created_at: new Date('2024-01-01'), ...overrides };
}

const noop: NextFunction = jest.fn();

describe('createRegisterHandler', () => {
  let infoSpy: jest.SpyInstance;

  beforeEach(() => {
    infoSpy = jest.spyOn(console, 'info').mockImplementation(() => undefined);
  });

describe('registerHandler', () => {
  it('covers registration handler behaviors', async () => {
  // ── 201 on success ─────────────────────────────────────────────────────────
  {
    const svc = new MockRegisterService();
    svc.result = makeUser();
    const handler = createRegisterHandler(svc as unknown as RegisterService);
    const res = makeRes();
    await handler(makeReq({ email: 'investor@example.com', password: 'StrongSecret123!' }), res, (e: unknown) => { if (e) throw e; });
    const { statusCode, jsonData } = res._get();
    assert.strictEqual(statusCode, 201, `expected 201 got ${statusCode}`);
    assert.deepStrictEqual((jsonData as any).user, { id: 'user-1', email: 'investor@example.com', role: 'investor' });
  }

  it('accepts optional name field and ignores it', async () => {
    const svc = new MockRegisterService();
    svc.result = makeUser({ email: 'alice@example.com' });
    const handler = createRegisterHandler(svc as unknown as RegisterService);
    const res = makeRes();
    await handler(makeReq({ email: 'alice@example.com', password: 'StrongPass555!', name: 'Alice' }), res, (e: unknown) => { if (e) throw e; });
    assert.strictEqual(res._get().statusCode, 201);
  }

  it('emits a structured info log on success without PII', async () => {
    const svc = new MockRegisterService();
    svc.result = makeUser();
    const handler = createRegisterHandler(svc as unknown as RegisterService);
    await handler(makeReq({ email: 'investor@example.com', password: 'secret123' }), makeRes(), noop);
    expect(infoSpy).toHaveBeenCalledTimes(1);
    const log = JSON.parse(infoSpy.mock.calls[0][0] as string);
    expect(log.type).toBe('auth');
    expect(log.event).toBe('STARTUP_REGISTER_SUCCESS');
    expect(log.userId).toBe('user-1');
    expect(JSON.stringify(log)).not.toContain('investor@example.com');
  });

  it('returns 400 VALIDATION_ERROR when email is missing', async () => {
    const svc = new MockRegisterService();
    const handler = createRegisterHandler(svc as unknown as RegisterService);
    const res = makeRes();
    let capturedErr: any = null;
    await handler(makeReq({ password: 'password1' }), res, (e: unknown) => { capturedErr = e; });
    assert(capturedErr instanceof AppError);
    assert.strictEqual(capturedErr.statusCode, 400);
    assert.strictEqual(capturedErr.code, ErrorCode.BAD_REQUEST);
  }

  it('returns 400 VALIDATION_ERROR when password is missing', async () => {
    const svc = new MockRegisterService();
    const handler = createRegisterHandler(svc as unknown as RegisterService);
    const res = makeRes();
    let capturedErr: any = null;
    await handler(makeReq({ email: 'investor@example.com' }), res, (e: unknown) => { capturedErr = e; });
    assert(capturedErr instanceof AppError);
    assert.strictEqual(capturedErr.statusCode, 400);
  }

  it('returns 400 VALIDATION_ERROR when body is absent', async () => {
    const svc = new MockRegisterService();
    const handler = createRegisterHandler(svc as unknown as RegisterService);
    const res = makeRes();
    let capturedErr: any = null;
    await handler(makeReq(undefined), res, (e: unknown) => { capturedErr = e; });
    assert(capturedErr instanceof AppError);
    assert.strictEqual(capturedErr.statusCode, 400);
  }

  it('returns 400 VALIDATION_ERROR when email is not a string', async () => {
    const svc = new MockRegisterService();
    const handler = createRegisterHandler(svc as unknown as RegisterService);
    const res = makeRes();
    let capturedErr: any = null;
    await handler(makeReq({ email: 123, password: 'password1' }), res, (e: unknown) => { capturedErr = e; });
    assert(capturedErr instanceof AppError);
    assert.strictEqual(capturedErr.statusCode, 400);
  }

  it('returns 400 VALIDATION_ERROR for invalid email format', async () => {
    const svc = new MockRegisterService();
    const handler = createRegisterHandler(svc as unknown as RegisterService);
    const res = makeRes();
    let capturedErr: any = null;
    await handler(makeReq({ email: 'notanemail', password: 'password1' }), res, (e: unknown) => { capturedErr = e; });
    assert(capturedErr instanceof AppError);
    assert.strictEqual(capturedErr.statusCode, 400);
    assert.match(capturedErr.message, /email/i);
  }

  // ── Password strength validation (forwarded from service) ──────────────────
  {
    const svc = new MockRegisterService();
    const err = new AppError(ErrorCode.VALIDATION_ERROR, 'Weak password', 400);
    svc.shouldThrow = err;
    const handler = createRegisterHandler(svc as unknown as RegisterService);
    const res = makeRes();
    let capturedErr: any = null;
    await handler(makeReq({ email: 'investor@example.com', password: 'short' }), res, (e: unknown) => { capturedErr = e; });
    assert.strictEqual(capturedErr, err);
  }

  it('returns 409 CONFLICT when service throws DuplicateEmailError', async () => {
    const svc = new MockRegisterService();
    svc.shouldThrow = new DuplicateEmailError();
    const handler = createRegisterHandler(svc as unknown as RegisterService);
    const res = makeRes();
    let capturedErr: any = null;
    await handler(makeReq({ email: 'taken@example.com', password: 'StrongPass666!' }), res, (e: unknown) => { capturedErr = e; });
    assert(capturedErr instanceof AppError);
    assert.strictEqual(capturedErr.statusCode, 409);
    assert.strictEqual(capturedErr.code, ErrorCode.CONFLICT);
    assert.strictEqual(capturedErr.message, 'Email already registered');
  }

  // ── 409 when service throws UniqueConstraintError ────────────────────────────
  {
    const svc = new MockRegisterService();
    svc.shouldThrow = new UniqueConstraintError('email');
    const handler = createRegisterHandler(svc as unknown as RegisterService);
    const res = makeRes();
    let capturedErr: any = null;
    await handler(makeReq({ email: 'taken@example.com', password: 'StrongPass666!' }), res, (e: unknown) => { capturedErr = e; });
    assert(capturedErr instanceof AppError);
    assert.strictEqual(capturedErr.statusCode, 409);
    assert.strictEqual(capturedErr.code, ErrorCode.CONFLICT);
  }

  it('409 response body does not expose stack or internal details', async () => {
    const svc = new MockRegisterService();
    svc.shouldThrow = new DuplicateEmailError();
    const handler = createRegisterHandler(svc as unknown as RegisterService);
    const res = makeRes();
    await handler(makeReq({ email: 'investor@example.com', password: 'StrongPass777!' }), res, (e: unknown) => { capturedErr = e; });
    assert(capturedErr instanceof Error && capturedErr.message === 'unexpected DB failure');
  }
  });
});

