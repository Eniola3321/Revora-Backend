import DistributionEngine, { BalanceRow, DistributionBatchResult } from './distributionEngine';

class MockDistributionRepo {
  public runs: any[] = [];
  public payouts: any[] = [];
  public failNextRunCount = 0;
  public failNextPayoutCount = 0;
  public failSpecificPayouts: number[] = []; // indices of payouts that should fail

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

  // ═══════════════════════════════════════════════════════════════════════════
  // Batch Processing Tests
  // ═══════════════════════════════════════════════════════════════════════════

  describe('batch processing', () => {
    it('processes large investor sets in batches', async () => {
      const repo = new MockDistributionRepo();
      // Create 150 investors
      const balances = Array.from({ length: 150 }, (_, i) => ({
        investor_id: `i${i + 1}`,
        balance: 100,
      }));

      const engine = new DistributionEngine(
        null,
        repo,
        new MockBalanceProvider(balances),
        { maxRetries: 1, initialDelayMs: 0, batchSize: 50 },
      );

      const result = await engine.distributeWithBatch(
        'off-batch-1',
        { start: new Date('2026-05-01'), end: new Date('2026-05-31') },
        15000,
      );

      // All payouts should succeed
      expect(result.successfulPayouts).toHaveLength(150);
      expect(result.failedPayouts).toHaveLength(0);
      expect(result.totalPayouts).toBe(150);
      expect(repo.payouts).toHaveLength(150);
    });

    it('handles partial batch failures gracefully', async () => {
      const repo = new MockDistributionRepo();
      const balances = Array.from({ length: 10 }, (_, i) => ({
        investor_id: `i${i + 1}`,
        balance: 100,
      }));

      // Make payouts at indices 3 and 7 fail
      repo.failSpecificPayouts = [3, 7];

      const engine = new DistributionEngine(
        null,
        repo,
        new MockBalanceProvider(balances),
        { maxRetries: 1, initialDelayMs: 0, batchSize: 5 },
      );

      const result = await engine.distributeWithBatch(
        'off-batch-2',
        { start: new Date('2026-06-01'), end: new Date('2026-06-30') },
        1000,
      );

      // 8 should succeed, 2 should fail
      expect(result.successfulPayouts).toHaveLength(8);
      expect(result.failedPayouts).toHaveLength(2);
      expect(result.failedPayouts[0].investor_id).toBe('i4');
      expect(result.failedPayouts[1].investor_id).toBe('i8');
      expect(result.failedPayouts[0].errorClass).toBeDefined();
    });

    it('processes single investor distribution (batch size = 1)', async () => {
      const repo = new MockDistributionRepo();
      const engine = new DistributionEngine(
        null,
        repo,
        new MockBalanceProvider([{ investor_id: 'i1', balance: 100 }]),
        { maxRetries: 1, initialDelayMs: 0, batchSize: 1 },
      );

      const result = await engine.distributeWithBatch(
        'off-batch-3',
        { start: new Date('2026-07-01'), end: new Date('2026-07-31') },
        50,
      );

      expect(result.successfulPayouts).toEqual([{ investor_id: 'i1', amount: '50.00' }]);
      expect(result.failedPayouts).toHaveLength(0);
    });

    it('handles very small revenue amounts with rounding', async () => {
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

      const result = await engine.distributeWithBatch(
        'off-batch-4',
        { start: new Date('2026-08-01'), end: new Date('2026-08-31') },
        0.03,
      );

      const sum = result.successfulPayouts.reduce((acc, p) => acc + Number(p.amount), 0);
      expect(sum).toBeCloseTo(0.03, 2);
      expect(result.successfulPayouts).toHaveLength(3);
    });

    it('handles very large revenue amounts without precision loss', async () => {
      const repo = new MockDistributionRepo();
      const balances = [
        { investor_id: 'i1', balance: 50 },
        { investor_id: 'i2', balance: 50 },
      ];

      const engine = new DistributionEngine(
        null,
        repo,
        new MockBalanceProvider(balances),
        { maxRetries: 1, initialDelayMs: 0 },
      );

      const result = await engine.distributeWithBatch(
        'off-batch-5',
        { start: new Date('2026-09-01'), end: new Date('2026-09-30') },
        1000000000,
      );

      const sum = result.successfulPayouts.reduce((acc, p) => acc + Number(p.amount), 0);
      expect(sum).toBeCloseTo(1000000000, 2);
      expect(result.successfulPayouts).toEqual([
        { investor_id: 'i1', amount: '500000000.00' },
        { investor_id: 'i2', amount: '500000000.00' },
      ]);
    });

    it('continues processing next batch after batch failure', async () => {
      const repo = new MockDistributionRepo();
      const balances = Array.from({ length: 15 }, (_, i) => ({
        investor_id: `i${i + 1}`,
        balance: 100,
      }));

      const engine = new DistributionEngine(
        null,
        repo,
        new MockBalanceProvider(balances),
        { maxRetries: 1, initialDelayMs: 0, batchSize: 5 },
      );

      // Mock to fail entire batch 2
      const originalCreatePayout = repo.createPayout.bind(repo);
      let callCount = 0;
      repo.createPayout = async (input: any) => {
        callCount++;
        // Fail all payouts in batch 2 (calls 6-10)
        if (callCount >= 6 && callCount <= 10) {
          throw new Error('Batch 2 failure');
        }
        return originalCreatePayout(input);
      };

      const result = await engine.distributeWithBatch(
        'off-batch-6',
        { start: new Date('2026-10-01'), end: new Date('2026-10-31') },
        1500,
      );

      // Batch 1 (5 payouts) + Batch 3 (5 payouts) should succeed
      expect(result.successfulPayouts.length).toBeGreaterThanOrEqual(10);
      expect(result.failedPayouts.length).toBeGreaterThanOrEqual(5);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Error Classification Tests
  // ═════════════════──────────────────────────────────────────────────────────

  describe('error classification', () => {
    it('classifies payout errors without exposing raw messages to clients', async () => {
      const repo = new MockDistributionRepo();
      repo.failSpecificPayouts = [0];

      const engine = new DistributionEngine(
        null,
        repo,
        new MockBalanceProvider([
          { investor_id: 'i1', balance: 50 },
          { investor_id: 'i2', balance: 50 },
        ]),
        { maxRetries: 1, initialDelayMs: 0 },
      );

      const result = await engine.distributeWithBatch(
        'off-err-1',
        { start: new Date('2026-11-01'), end: new Date('2026-11-30') },
        100,
      );

      expect(result.failedPayouts).toHaveLength(1);
      expect(result.failedPayouts[0].errorClass).toBeDefined();
      expect(result.successfulPayouts).toHaveLength(1);
    });

    it('maintains backward compatibility with distribute() method', async () => {
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
        'off-err-2',
        { start: new Date('2026-12-01'), end: new Date('2026-12-31') },
        100,
      );

      // Original interface should still work
      expect(result.payouts).toEqual([
        { investor_id: 'i1', amount: '70.00' },
        { investor_id: 'i2', amount: '30.00' },
      ]);
      expect(result.distributionRun).toBeDefined();
    });
  });
});
