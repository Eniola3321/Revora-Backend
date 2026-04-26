import assert from 'node:assert/strict';
import { createDistributionHandlers } from './distributions';

class MockEngine {
  lastArgs: any = null;
  async distribute(offeringId: string, period: any, revenueAmount: number) {
    this.lastArgs = { offeringId, period, revenueAmount };
    return { distributionRun: { id: 'run-1', offering_id: offeringId }, payouts: [{ investor_id: 'i1', amount: '50.00' }] };
  }
}

class MockOfferingRepo {
  constructor(private rows: any) {}
  async getById(id: string) { return this.rows[id] ?? null; }
}

function makeReq(user: any, params: any = {}, body: any = {}) { return { user, params, body } as any; }
function makeRes() { let statusCode = 200; let jsonData: any = null; return { status(code: number) { statusCode = code; return this; }, json(obj: any) { jsonData = obj; return this; }, _get() { return { statusCode, jsonData }; } } as any; }

describe('distributions routes', () => {
  describe('authorization and validation', () => {
  it('covers admin/startup authorization and validation for triggerDistribution', async () => {
  const engine = new MockEngine();
  const offeringRows: any = { off1: { id: 'off1', issuer_id: 's1' } };
  const repo = new MockOfferingRepo(offeringRows);
  const handlers = createDistributionHandlers(engine as any, repo as any);

  // Admin success
  const req1 = makeReq({ id: 'admin1', role: 'admin' }, { id: 'off1' }, { revenue_amount: 100, period: { start: new Date().toISOString(), end: new Date().toISOString() } });
  const res1 = makeRes();
  await handlers.triggerDistribution(req1, res1, (e: any) => { throw e; });
  const out1 = res1._get();
  assert(out1.statusCode === 200);
  assert(out1.jsonData.run_id === 'run-1');

  // Startup owner success
  const req2 = makeReq({ id: 's1', role: 'startup' }, { id: 'off1' }, { revenueAmount: 200, start: new Date().toISOString(), end: new Date().toISOString() });
  const res2 = makeRes();
  await handlers.triggerDistribution(req2, res2, (e: any) => { throw e; });
  const out2 = res2._get();
  assert(out2.statusCode === 200);

  // Forbidden startup (not issuer)
  const req3 = makeReq({ id: 's2', role: 'startup' }, { id: 'off1' }, { revenue_amount: 50, period: { start: new Date().toISOString(), end: new Date().toISOString() } });
  const res3 = makeRes();
  await handlers.triggerDistribution(req3, res3, (e: any) => { throw e; });
  const out3 = res3._get();
  assert(out3.statusCode === 403);

  // Unauthorized
  const req4 = makeReq(null, { id: 'off1' }, { revenue_amount: 10, period: { start: new Date().toISOString(), end: new Date().toISOString() } });
  const res4 = makeRes();
  await handlers.triggerDistribution(req4, res4, (e: any) => { throw e; });
  const out4 = res4._get();
  assert(out4.statusCode === 401);

  // Bad input
  const req5 = makeReq({ id: 'admin1', role: 'admin' }, { id: 'off1' }, { period: { start: new Date().toISOString() } });
  const res5 = makeRes();
  await handlers.triggerDistribution(req5, res5, (e: any) => { throw e; });
  const out5 = res5._get();
  assert(out5.statusCode === 400);
  });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Validation Edge Cases
  // ═══════════════════════════════════════════════════════════════════════════

  describe('validation edge cases', () => {
    const engine = new MockEngine();
    const offeringRows: any = { off1: { id: 'off1', issuer_id: 's1' } };
    const repo = new MockOfferingRepo(offeringRows);
    const handlers = createDistributionHandlers(engine as any, repo as any);

    it('returns 400 for negative revenue_amount', async () => {
      const req = makeReq({ id: 'admin1', role: 'admin' }, { id: 'off1' }, { revenue_amount: -100, period: { start: '2026-01-01', end: '2026-01-31' } });
      const res = makeRes();
      await handlers.triggerDistribution(req, res, (e: any) => { throw e; });
      assert.strictEqual(res._get().statusCode, 400);
    });

    it('returns 400 for zero revenue_amount', async () => {
      const req = makeReq({ id: 'admin1', role: 'admin' }, { id: 'off1' }, { revenue_amount: 0, period: { start: '2026-01-01', end: '2026-01-31' } });
      const res = makeRes();
      await handlers.triggerDistribution(req, res, (e: any) => { throw e; });
      assert.strictEqual(res._get().statusCode, 400);
    });

    it('returns 400 for invalid date format', async () => {
      const req = makeReq({ id: 'admin1', role: 'admin' }, { id: 'off1' }, { revenue_amount: 100, period: { start: 'not-a-date', end: '2026-01-31' } });
      const res = makeRes();
      await handlers.triggerDistribution(req, res, (e: any) => { throw e; });
      assert.strictEqual(res._get().statusCode, 400);
      assert(res._get().jsonData.message.includes('date'));
    });

    it('returns 400 when end date is before start date', async () => {
      const req = makeReq({ id: 'admin1', role: 'admin' }, { id: 'off1' }, { revenue_amount: 100, period: { start: '2026-12-31', end: '2026-01-01' } });
      const res = makeRes();
      await handlers.triggerDistribution(req, res, (e: any) => { throw e; });
      assert.strictEqual(res._get().statusCode, 400);
      assert(res._get().jsonData.message.includes('End date'));
    });

    it('returns 400 for missing period object', async () => {
      const req = makeReq({ id: 'admin1', role: 'admin' }, { id: 'off1' }, { revenue_amount: 100 });
      const res = makeRes();
      await handlers.triggerDistribution(req, res, (e: any) => { throw e; });
      assert.strictEqual(res._get().statusCode, 400);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Authorization Scenarios
  // ═══════════════════════════════════════════════════════════════════════════

  describe('authorization scenarios', () => {
    const engine = new MockEngine();
    const offeringRows: any = { off1: { id: 'off1', issuer_id: 's1' } };
    const repo = new MockOfferingRepo(offeringRows);
    const handlers = createDistributionHandlers(engine as any, repo as any);

    it('returns 403 for investor role', async () => {
      const req = makeReq({ id: 'inv1', role: 'investor' }, { id: 'off1' }, { revenue_amount: 100, period: { start: '2026-01-01', end: '2026-01-31' } });
      const res = makeRes();
      await handlers.triggerDistribution(req, res, (e: any) => { throw e; });
      assert.strictEqual(res._get().statusCode, 403);
    });

    it('returns 404 for non-existent offering', async () => {
      const req = makeReq({ id: 's1', role: 'startup' }, { id: 'off999' }, { revenue_amount: 100, period: { start: '2026-01-01', end: '2026-01-31' } });
      const res = makeRes();
      await handlers.triggerDistribution(req, res, (e: any) => { throw e; });
      assert.strictEqual(res._get().statusCode, 404);
    });

    it('returns 403 when offeringRepo is not available', async () => {
      const handlersNoRepo = createDistributionHandlers(engine as any, undefined);
      const req = makeReq({ id: 's1', role: 'startup' }, { id: 'off1' }, { revenue_amount: 100, period: { start: '2026-01-01', end: '2026-01-31' } });
      const res = makeRes();
      await handlersNoRepo.triggerDistribution(req, res, (e: any) => { throw e; });
      assert.strictEqual(res._get().statusCode, 403);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Response Format
  // ═══════════════════════════════════════════════════════════════════════════

  describe('response format', () => {
    const engine = new MockEngine();
    const offeringRows: any = { off1: { id: 'off1', issuer_id: 's1' } };
    const repo = new MockOfferingRepo(offeringRows);
    const handlers = createDistributionHandlers(engine as any, repo as any);

    it('includes run_id, payouts, and total_payouts in response', async () => {
      const req = makeReq({ id: 'admin1', role: 'admin' }, { id: 'off1' }, { revenue_amount: 100, period: { start: '2026-01-01', end: '2026-01-31' } });
      const res = makeRes();
      await handlers.triggerDistribution(req, res, (e: any) => { throw e; });
      const { jsonData } = res._get();
      assert(jsonData.run_id === 'run-1');
      assert(Array.isArray(jsonData.payouts));
      assert(typeof jsonData.total_payouts === 'number');
      assert(jsonData.total_payouts === 1);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Error Handling
  // ═══════════════════════════════════════════════════════════════════════════

  describe('error handling', () => {
    it('calls next(err) on engine failure', async () => {
      const failingEngine = {
        distribute: async () => { throw new Error('Engine failure'); },
      };
      const offeringRows: any = { off1: { id: 'off1', issuer_id: 's1' } };
      const repo = new MockOfferingRepo(offeringRows);
      const handlers = createDistributionHandlers(failingEngine as any, repo as any);

      const req = makeReq({ id: 'admin1', role: 'admin' }, { id: 'off1' }, { revenue_amount: 100, period: { start: '2026-01-01', end: '2026-01-31' } });
      const res = makeRes();
      let capturedErr: any = null;
      await handlers.triggerDistribution(req, res, (e: any) => { capturedErr = e; });
      assert(capturedErr instanceof Error && capturedErr.message === 'Engine failure');
    });
  });
});
