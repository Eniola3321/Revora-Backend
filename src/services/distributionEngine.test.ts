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
  public failSpecificPayouts: number[] = []; // indices of payouts that should fail

  async createDistributionRun(input: any): Promise<any> {
    if (this.failNextRunCount > 0) {
      this.failNextRunCount--;
      throw new Error('Database error (run)');
    }
    const run = { id: `run-${this.runs.length + 1}`, ...input };
    this.runs.push(run);
    return run;
  }

  async createPayout(input: any): Promise<any> {
    // Check if this specific payout should fail
    const payoutIndex = this.payouts.length;
    if (this.failNextPayoutCount > 0) {
      this.failNextPayoutCount -= 1;
      throw new Error('Database error (payout)');
    }
    if (this.failSpecificPayouts.includes(payoutIndex)) {
      throw new Error(`Simulated failure for payout at index ${payoutIndex}`);
    }

    const payout = { id: `p-${this.payouts.length + 1}`, ...input };
    this.payouts.push(payout);
    return payout;
  }
}

class MockBalanceProvider {
  constructor(private readonly balances: BalanceRow[], private failCount = 0) {}

  async getBalances(_offeringId: string, _periodId: string): Promise<BalanceRow[]> {
    if (this.failCount > 0) {
      this.failCount--;
      throw new Error('Stellar RPC Timeout');
    }
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
      { id: 'p1', start: new Date('2026-01-01'), end: new Date('2026-01-31') },
      100,
    );

    expect(result.payouts).toEqual([
      { investor_id: 'i1', amount: '70.00' },
      { investor_id: 'i2', amount: '30.00' },
    ]);
    expect(repo.runs).toHaveLength(1);
    expect(repo.payouts).toHaveLength(2);
    expect(repo.runs[0].status).toBe('completed');
  });

  it('is idempotent when called multiple times', async () => {
    const repo = new MockDistributionRepo();
    const balances = [{ investor_id: 'i1', balance: 100 }];
    const engine = new DistributionEngine(
      null,
      repo,
      new MockBalanceProvider(balances),
      { maxRetries: 1, initialDelayMs: 0 },
    );

    const period = { id: 'p1', start: new Date(), end: new Date() };

    const res1 = await engine.distribute('off-1', period, 50);
    const res2 = await engine.distribute('off-1', period, 50);

    expect(res1.distributionRun.id).toBe(res2.distributionRun.id);
    expect(res1.payouts).toEqual(res2.payouts);
    expect(repo.runs).toHaveLength(1);
    expect(repo.payouts).toHaveLength(1);
  });

  it('resumes from a partial failure', async () => {
    const repo = new MockDistributionRepo();
    const balances = [
      { investor_id: 'i1', balance: 50 },
      { investor_id: 'i2', balance: 50 },
    ];
    
    // Fail on the SECOND payout (index 1)
    repo.failOnPayoutIndex = 1;

    const engine = new DistributionEngine(
      null,
      repo,
      new MockBalanceProvider(balances),
      { maxRetries: 1, initialDelayMs: 0 },
    );

    const period = { id: 'p2', start: new Date(), end: new Date() };

    await expect(engine.distribute('off-2', period, 100)).rejects.toThrow();
    
    expect(repo.runs).toHaveLength(1);
    expect(repo.payouts).toHaveLength(1); // First payout should have succeeded
    expect(repo.runs[0].status).toBe('failed');

    // Second run should resume
    const res2 = await engine.distribute('off-2', period, 100);
    
    expect(repo.runs).toHaveLength(1); // Same run
    expect(repo.payouts).toHaveLength(2); // Now both payouts
    expect(repo.runs[0].status).toBe('completed');
    expect(res2.payouts).toHaveLength(2);
  });

  it('classifies and retries Stellar RPC failures', async () => {
    const repo = new MockDistributionRepo();
    const balances = [{ investor_id: 'i1', balance: 100 }];
    
    const provider = new MockBalanceProvider(balances, 1); // Fails once
    const engine = new DistributionEngine(
      null,
      repo,
      provider,
      { maxRetries: 2, initialDelayMs: 0, backoffFactor: 1 },
    );

    const result = await engine.distribute('off-3', { id: 'p3', end: new Date() } as any, 10);
    expect(result.payouts[0].amount).toBe('10.00');
  });

  it('throws after exhausting retries for balance fetching', async () => {
    const provider = new MockBalanceProvider([], 3); // Fails 3 times
    const engine = new DistributionEngine(null, new MockDistributionRepo(), provider, { maxRetries: 2, initialDelayMs: 0 });
    await expect(engine.distribute('off-fail', { id: 'p', end: new Date() } as any, 100)).rejects.toThrow(/Failed to acquire balances/);
  });

  it('throws if no balances are found', async () => {
    const provider = new MockBalanceProvider([]);
    const engine = new DistributionEngine(null, new MockDistributionRepo(), provider, { maxRetries: 1, initialDelayMs: 0 });
    await expect(engine.distribute('off-empty', { id: 'p', end: new Date() } as any, 100)).rejects.toThrow(/No investors or balances found/);
  });

  it('throws if total balance is zero', async () => {
    const provider = new MockBalanceProvider([{ investor_id: 'i1', balance: 0 }]);
    const engine = new DistributionEngine(null, new MockDistributionRepo(), provider, { maxRetries: 1, initialDelayMs: 0 });
    await expect(engine.distribute('off-zero', { id: 'p', end: new Date() } as any, 100)).rejects.toThrow(/Total balance must be > 0/);
  });

  it('adjusts rounding to match revenue amount', async () => {
    const balances = [
      { investor_id: 'i1', balance: 1 },
      { investor_id: 'i2', balance: 1 },
      { investor_id: 'i3', balance: 1 },
    ];
    const engine = new DistributionEngine(null, new MockDistributionRepo(), new MockBalanceProvider(balances), { maxRetries: 1, initialDelayMs: 0 });
    const result = await engine.distribute('off-round', { id: 'p', end: new Date() } as any, 100);
    const sum = result.payouts.reduce((s, p) => s + Number(p.amount), 0);
    expect(sum).toBe(100.00);
    // One should be 33.34, others 33.33
    const counts = result.payouts.reduce((acc: any, p) => { acc[p.amount] = (acc[p.amount] || 0) + 1; return acc; }, {});
    expect(counts['33.34']).toBe(1);
    expect(counts['33.33']).toBe(2);
  });

  it('throws if run initialization fails after retries', async () => {
    const repo = new MockDistributionRepo();
    repo.failNextRunCount = 5;
    const engine = new DistributionEngine(null, repo, new MockBalanceProvider([{ investor_id: 'i1', balance: 100 }]), { maxRetries: 1, initialDelayMs: 0 });
    await expect(engine.distribute('off-run-fail', { id: 'p', end: new Date() } as any, 100)).rejects.toThrow(/Failed to initialize distribution run/);
  });

  it('uses offeringRepo if balanceProvider is missing', async () => {
    const offeringRepo = {
      getInvestors: jest.fn().mockResolvedValue([{ investor_id: 'i1', balance: 100 }])
    };
    const engine = new DistributionEngine(offeringRepo, new MockDistributionRepo(), undefined, { maxRetries: 1, initialDelayMs: 0 });
    const result = await engine.distribute('off-repo', { id: 'p', end: new Date() } as any, 100);
    expect(result.payouts).toHaveLength(1);
    expect(offeringRepo.getInvestors).toHaveBeenCalled();
  });

  it('uses listInvestors if getInvestors is missing', async () => {
    const offeringRepo = {
      listInvestors: jest.fn().mockResolvedValue([{ investor_id: 'i1', balance: 100 }])
    };
    const engine = new DistributionEngine(offeringRepo, new MockDistributionRepo(), undefined, { maxRetries: 1, initialDelayMs: 0 });
    const result = await engine.distribute('off-list', { id: 'p', end: new Date() } as any, 100);
    expect(result.payouts).toHaveLength(1);
    expect(offeringRepo.listInvestors).toHaveBeenCalled();
  });

  it('throws if no balance source is available', async () => {
    const engine = new DistributionEngine(null, new MockDistributionRepo(), undefined, { maxRetries: 1, initialDelayMs: 0 });
    await expect(engine.distribute('off-none', { id: 'p', end: new Date() } as any, 100)).rejects.toThrow(/No balance source available/);
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
