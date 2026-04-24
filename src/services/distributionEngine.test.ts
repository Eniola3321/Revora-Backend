import DistributionEngine, { BalanceRow } from './distributionEngine';
import { ErrorCode } from '../lib/errors';

class MockDistributionRepo {
  public runs: any[] = [];
  public payouts: any[] = [];
  public failNextRunCount = 0;
  public failOnPayoutIndex = -1;
  private payoutCounter = 0;

  async findRunByParams(offeringId: string, periodId: string, totalAmount: string): Promise<any | null> {
    return this.runs.find(r => r.offering_id === offeringId && r.period_id === periodId && r.total_amount === totalAmount) || null;
  }

  async getPayoutsForRun(runId: string): Promise<any[]> {
    return this.payouts.filter(p => p.distribution_id === runId);
  }

  async updateRunStatus(id: string, status: string): Promise<void> {
    const run = this.runs.find(r => r.id === id);
    if (run) run.status = status;
  }

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
    if (this.payoutCounter === this.failOnPayoutIndex) {
      this.failOnPayoutIndex = -1; // Reset
      throw new Error('Database error (payout)');
    }
    this.payoutCounter++;
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
});
