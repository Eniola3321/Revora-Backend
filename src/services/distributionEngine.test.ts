import DistributionEngine, { BalanceRow } from './distributionEngine';
import {
  classifyStellarRPCFailure,
  isStellarRPCRetryable,
  StellarRPCFailureClass,
} from '../lib/stellarRpcFailure';

class MockDistributionRepo {
  public runs: any[] = [];
  public payouts: any[] = [];
  public failNextRunCount = 0;
  public failNextPayoutCount = 0;

  async createDistributionRun(input: any): Promise<any> {
    if (this.failNextRunCount > 0) {
      this.failNextRunCount -= 1;
      throw new Error('Database error (run)');
    }

    const run = { id: `run-${this.runs.length + 1}`, ...input };
    this.runs.push(run);
    return run;
  }

  async createPayout(input: any): Promise<any> {
    if (this.failNextPayoutCount > 0) {
      this.failNextPayoutCount -= 1;
      throw new Error('Database error (payout)');
    }

    const payout = { id: `p-${this.payouts.length + 1}`, ...input };
    this.payouts.push(payout);
    return payout;
  }
}

class MockBalanceProvider {
  constructor(private readonly balances: BalanceRow[]) {}

  async getBalances(_offeringId: string, _period: { start: Date; end: Date }): Promise<BalanceRow[]> {
    return this.balances;
  }
}

describe('DistributionEngine', () => {
  it('prorates payouts correctly', async () => {
    const repo = new MockDistributionRepo();
    const balances = [
      { investor_id: 'i1', balance: 70 },
      { investor_id: 'i2', balance: 30 },
    ];

    const engine = new DistributionEngine(
      null,
      repo,
      new MockBalanceProvider(balances),
      { maxRetries: 1, initialDelayMs: 0 },
    );

    const result = await engine.distribute(
      'off-1',
      { start: new Date('2026-01-01'), end: new Date('2026-01-31') },
      100,
    );

    expect(result.payouts).toEqual([
      { investor_id: 'i1', amount: '70.00' },
      { investor_id: 'i2', amount: '30.00' },
    ]);
    expect(repo.runs).toHaveLength(1);
    expect(repo.payouts).toHaveLength(2);
  });

  it('preserves payout total after rounding', async () => {
    const repo = new MockDistributionRepo();
    const balances = [
      { investor_id: 'i1', balance: 1 },
      { investor_id: 'i2', balance: 1 },
      { investor_id: 'i3', balance: 1 },
    ];

    const engine = new DistributionEngine(
      null,
      repo,
      new MockBalanceProvider(balances),
      { maxRetries: 1, initialDelayMs: 0 },
    );

    const result = await engine.distribute(
      'off-2',
      { start: new Date('2026-02-01'), end: new Date('2026-02-28') },
      100,
    );

    const sum = result.payouts.reduce((acc, item) => acc + Number(item.amount), 0);
    expect(sum).toBeCloseTo(100, 2);
  });

  it('throws when total balance is zero', async () => {
    const repo = new MockDistributionRepo();
    const engine = new DistributionEngine(
      null,
      repo,
      new MockBalanceProvider([{ investor_id: 'i1', balance: 0 }]),
      { maxRetries: 1, initialDelayMs: 0 },
    );

    await expect(
      engine.distribute(
        'off-3',
        { start: new Date('2026-03-01'), end: new Date('2026-03-31') },
        50,
      ),
    ).rejects.toThrow('Total balance must be > 0 to distribute revenue');
  });

  it('retries transient run creation failures', async () => {
    const repo = new MockDistributionRepo();
    repo.failNextRunCount = 1;

    const engine = new DistributionEngine(
      null,
      repo,
      new MockBalanceProvider([{ investor_id: 'i1', balance: 100 }]),
      { maxRetries: 2, initialDelayMs: 0, backoffFactor: 1 },
    );

    const result = await engine.distribute(
      'off-4',
      { start: new Date('2026-04-01'), end: new Date('2026-04-30') },
      20,
    );

    expect(result.distributionRun.id).toBe('run-1');
    expect(result.payouts).toEqual([{ investor_id: 'i1', amount: '20.00' }]);
  });

  // ── Retry storm: exhausted budget throws, does not loop forever ────────────

  it('throws after maxRetries exhausted on balance fetch', async () => {
    const repo = new MockDistributionRepo();
    let calls = 0;
    const flakyProvider = {
      getBalances: async () => { calls++; throw new Error('flaky'); },
    };
    const engine = new DistributionEngine(null, repo, flakyProvider, { maxRetries: 3, initialDelayMs: 0 });

    await expect(
      engine.distribute('off-5', { start: new Date(), end: new Date() }, 10),
    ).rejects.toThrow('Failed to acquire balances after 3 attempts');

    expect(calls).toBe(3); // exactly maxRetries, no infinite loop
  });

  it('throws after maxRetries exhausted on payout creation', async () => {
    const repo = new MockDistributionRepo();
    repo.failNextPayoutCount = 99; // always fail
    const engine = new DistributionEngine(
      null, repo,
      new MockBalanceProvider([{ investor_id: 'i1', balance: 100 }]),
      { maxRetries: 2, initialDelayMs: 0 },
    );

    await expect(
      engine.distribute('off-6', { start: new Date(), end: new Date() }, 10),
    ).rejects.toThrow('Failed to create payout for investor i1 after 2 attempts');
  });

  it('succeeds on last allowed retry (boundary)', async () => {
    const repo = new MockDistributionRepo();
    repo.failNextRunCount = 2; // fail twice, succeed on 3rd (maxRetries=3)
    const engine = new DistributionEngine(
      null, repo,
      new MockBalanceProvider([{ investor_id: 'i1', balance: 100 }]),
      { maxRetries: 3, initialDelayMs: 0 },
    );

    const result = await engine.distribute('off-7', { start: new Date(), end: new Date() }, 50);
    expect(result.payouts).toEqual([{ investor_id: 'i1', amount: '50.00' }]);
  });

  // ── Stellar result-code classification wired into distribution errors ──────

  it('classifies a Stellar tx_bad_seq error as non-retryable TX_RESULT_CODE', () => {
    const err = { status: 400, extras: { result_codes: { transaction: 'tx_bad_seq' } } };
    expect(classifyStellarRPCFailure(err)).toBe(StellarRPCFailureClass.TX_RESULT_CODE);
    expect(isStellarRPCRetryable(StellarRPCFailureClass.TX_RESULT_CODE)).toBe(false);
  });

  it('classifies a Stellar op_underfunded error as non-retryable OP_RESULT_CODE', () => {
    const err = { status: 400, extras: { result_codes: { transaction: 'tx_failed', operations: ['op_underfunded'] } } };
    expect(classifyStellarRPCFailure(err)).toBe(StellarRPCFailureClass.OP_RESULT_CODE);
    expect(isStellarRPCRetryable(StellarRPCFailureClass.OP_RESULT_CODE)).toBe(false);
  });

  it('classifies a 503 upstream error as retryable', () => {
    const err = { status: 503 };
    expect(classifyStellarRPCFailure(err)).toBe(StellarRPCFailureClass.UPSTREAM_ERROR);
    expect(isStellarRPCRetryable(StellarRPCFailureClass.UPSTREAM_ERROR)).toBe(true);
  });

  it('throws when offeringId is empty', async () => {
    const repo = new MockDistributionRepo();
    const engine = new DistributionEngine(null, repo, new MockBalanceProvider([]), { maxRetries: 1, initialDelayMs: 0 });
    await expect(engine.distribute('', { start: new Date(), end: new Date() }, 10)).rejects.toThrow('offeringId is required');
  });

  it('throws when revenueAmount is zero', async () => {
    const repo = new MockDistributionRepo();
    const engine = new DistributionEngine(null, repo, new MockBalanceProvider([{ investor_id: 'i1', balance: 1 }]), { maxRetries: 1, initialDelayMs: 0 });
    await expect(engine.distribute('off-x', { start: new Date(), end: new Date() }, 0)).rejects.toThrow('revenueAmount must be > 0');
  });

  it('throws when no investors found', async () => {
    const repo = new MockDistributionRepo();
    const engine = new DistributionEngine(null, repo, new MockBalanceProvider([]), { maxRetries: 1, initialDelayMs: 0 });
    await expect(engine.distribute('off-x', { start: new Date(), end: new Date() }, 10)).rejects.toThrow('No investors or balances found');
  });

  it('uses offeringRepo.getInvestors when no balanceProvider', async () => {
    const repo = new MockDistributionRepo();
    const offeringRepo = { getInvestors: async () => [{ investor_id: 'i1', balance: 100 }] };
    const engine = new DistributionEngine(offeringRepo, repo, undefined, { maxRetries: 1, initialDelayMs: 0 });
    const result = await engine.distribute('off-8', { start: new Date(), end: new Date() }, 10);
    expect(result.payouts).toEqual([{ investor_id: 'i1', amount: '10.00' }]);
  });

  it('uses offeringRepo.listInvestors as fallback', async () => {
    const repo = new MockDistributionRepo();
    const offeringRepo = { listInvestors: async () => [{ investor_id: 'i2', balance: 50 }] };
    const engine = new DistributionEngine(offeringRepo, repo, undefined, { maxRetries: 1, initialDelayMs: 0 });
    const result = await engine.distribute('off-9', { start: new Date(), end: new Date() }, 20);
    expect(result.payouts).toEqual([{ investor_id: 'i2', amount: '20.00' }]);
  });

  it('throws when no balance source is available', async () => {
    const repo = new MockDistributionRepo();
    const engine = new DistributionEngine(null, repo, undefined, { maxRetries: 1, initialDelayMs: 0 });
    await expect(engine.distribute('off-x', { start: new Date(), end: new Date() }, 10)).rejects.toThrow('Failed to acquire balances');
  });

  it('logs retries when logRetries is true', async () => {
    const repo = new MockDistributionRepo();
    repo.failNextRunCount = 1;
    const spy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const engine = new DistributionEngine(
      null, repo,
      new MockBalanceProvider([{ investor_id: 'i1', balance: 100 }]),
      { maxRetries: 2, initialDelayMs: 0, logRetries: true },
    );
    await engine.distribute('off-log', { start: new Date(), end: new Date() }, 5);
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('[DistributionEngine]'));
    spy.mockRestore();
  });
});
