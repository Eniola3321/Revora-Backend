import { globalLogger } from '../lib/logger';
import { Errors } from '../lib/errors';
import { classifyStellarRPCFailure } from '../lib/stellarRpcFailure';

/**
 * @title DistributionEngine
 * @notice Computes per-investor payout amounts based on token balances and persists them.
 * @dev This service handles the core logic for revenue distribution, including:
 * 1. Balance acquisition (via provider or repository)
 * 2. Proration of revenue based on balances
 * 3. Rounding adjustment to ensure total payout equals revenue amount
 * 4. Persistence of distribution runs and individual payouts with a retry strategy
 * 5. Idempotency and at-least-once safety via resumption logic
 */

export interface BalanceRow {
  investor_id: string;
  balance: number; // numeric balance; precision handled by callers/tests
}

export interface DistributionResult {
  distributionRun: any;
  payouts: Array<{ investor_id: string; amount: string }>;
}

export interface DistributionEngineOptions {
  maxRetries?: number;
  initialDelayMs?: number;
  backoffFactor?: number;
}

export class DistributionEngine {
  private readonly maxRetries: number;
  private readonly initialDelayMs: number;
  private readonly backoffFactor: number;

  constructor(
    private offeringRepo: any,
    private distributionRepo: any,
    private balanceProvider?: { getBalances: (offeringId: string, period: any) => Promise<BalanceRow[]> },
    options: DistributionEngineOptions = {}
  ) {
    this.maxRetries = options.maxRetries ?? 3;
    this.initialDelayMs = options.initialDelayMs ?? 500;
    this.backoffFactor = options.backoffFactor ?? 2;
  }

  /**
   * @notice Distribute revenueAmount across investors for an offering and period.
   * @dev Implementation follows RC26Q2-B03 requirements:
   * - Idempotent: checks for existing runs with same parameters.
   * - Resumable: recovers from partial payout persistence failures.
   * - Secure: uses structured logging and standardized errors.
   */
  async distribute(
    offeringId: string,
    period: { id: string; start: Date; end: Date },
    revenueAmount: number
  ): Promise<DistributionResult> {
    const logger = globalLogger.child({ offeringId, periodId: period.id, revenueAmount });
    
    // 1. Validation
    if (!offeringId) throw Errors.badRequest('offeringId is required');
    if (revenueAmount <= 0) throw Errors.badRequest('revenueAmount must be > 0');
    if (!period || !period.id || !period.end) throw Errors.badRequest('Valid distribution period with ID is required');

    const amtStr = revenueAmount.toFixed(2);

    // 2. Idempotency Check: Look for an existing run
    let run = await this.distributionRepo.findRunByParams(offeringId, period.id, amtStr);
    
    if (run) {
      if (run.status === 'completed') {
        logger.info('Distribution already completed, returning cached results');
        const existingPayouts = await this.distributionRepo.getPayoutsForRun(run.id);
        return {
          distributionRun: run,
          payouts: existingPayouts.map((p: any) => ({ investor_id: p.investor_id, amount: p.amount })),
        };
      }
      logger.info('Resuming partially completed distribution', { runId: run.id, currentStatus: run.status });
    }

    // 3. Acquire balances with retry and classification
    let balances: BalanceRow[] = [];
    try {
      balances = await this.withRetry(() => this.fetchBalances(offeringId, period));
    } catch (err) {
      const failureClass = classifyStellarRPCFailure(err);
      logger.error('Failed to acquire balances', { error: err, failureClass });
      throw Errors.serviceUnavailable(`Failed to acquire balances (${failureClass}): ${err instanceof Error ? err.message : String(err)}`);
    }

    if (!balances || balances.length === 0) {
      throw Errors.badRequest('No investors or balances found for offering');
    }

    // 4. Sum balances and compute shares
    const totalBalance = balances.reduce((s, b) => s + Number(b.balance), 0);
    if (totalBalance <= 0) {
      throw Errors.badRequest('Total balance must be > 0 to distribute revenue');
    }

    const rawShares = balances.map((b) => ({
      investor_id: b.investor_id,
      raw: (Number(b.balance) / totalBalance) * revenueAmount,
    }));

    const rounded = rawShares.map((r) => ({
      investor_id: r.investor_id,
      amount: Math.round(r.raw * 100) / 100,
    }));

    const roundedSum = rounded.reduce((s, r) => s + r.amount, 0);
    const diff = Math.round((revenueAmount - roundedSum) * 100) / 100;

    if (Math.abs(diff) >= 0.01) {
      let maxIdx = 0;
      for (let i = 1; i < rawShares.length; i++) {
        if (rawShares[i].raw > rawShares[maxIdx].raw) maxIdx = i;
      }
      rounded[maxIdx].amount = Math.round((rounded[maxIdx].amount + diff) * 100) / 100;
    }

    // 5. Ensure distribution run exists and is in 'processing' state
    if (!run) {
      try {
        run = await this.withRetry(() =>
          this.distributionRepo.createDistributionRun({
            offering_id: offeringId,
            period_id: period.id,
            total_amount: amtStr,
            run_at: period.end,
            status: 'processing',
          })
        );
        logger.info('Created new distribution run', { runId: run.id });
      } catch (err) {
        logger.error('Failed to create distribution run', { error: err });
        throw Errors.internal('Failed to initialize distribution run');
      }
    } else if (run.status !== 'processing') {
      await this.distributionRepo.updateRunStatus(run.id, 'processing');
    }

    // 6. Persist payouts with resumption logic (at-least-once safety)
    const existingPayouts = await this.distributionRepo.getPayoutsForRun(run.id);
    const existingInvestorIds = new Set(existingPayouts.map((p: any) => p.investor_id));

    const finalPayouts: Array<{ investor_id: string; amount: string }> = [];

    for (const r of rounded) {
      const payoutAmtStr = r.amount.toFixed(2);
      
      if (existingInvestorIds.has(r.investor_id)) {
        logger.debug('Payout already exists for investor, skipping', { investorId: r.investor_id });
        finalPayouts.push({ investor_id: r.investor_id, amount: payoutAmtStr });
        continue;
      }

      try {
        await this.withRetry(() =>
          this.distributionRepo.createPayout({
            distribution_id: run.id,
            investor_id: r.investor_id,
            amount: payoutAmtStr,
            status: 'pending',
          })
        );
        finalPayouts.push({ investor_id: r.investor_id, amount: payoutAmtStr });
      } catch (err) {
        logger.error('Failed to create payout', { investorId: r.investor_id, error: err });
        await this.distributionRepo.updateRunStatus(run.id, 'failed');
        throw Errors.internal(`Failed to persist payout for investor ${r.investor_id}`);
      }
    }

    // 7. Finalize run
    await this.distributionRepo.updateRunStatus(run.id, 'completed');
    logger.info('Distribution run completed successfully', { runId: run.id, payoutCount: finalPayouts.length });

    return { distributionRun: { ...run, status: 'completed' }, payouts: finalPayouts };
  }

  /**
   * Internal helper to fetch balances from available sources
   */
  private async fetchBalances(offeringId: string, period: any): Promise<BalanceRow[]> {
    if (this.balanceProvider && typeof this.balanceProvider.getBalances === 'function') {
      return await this.balanceProvider.getBalances(offeringId, period.id);
    } else if (this.offeringRepo && typeof this.offeringRepo.getInvestors === 'function') {
      return await this.offeringRepo.getInvestors(offeringId, period);
    } else if (this.offeringRepo && typeof this.offeringRepo.listInvestors === 'function') {
      return await this.offeringRepo.listInvestors(offeringId, period);
    } else {
      throw new Error('No balance source available');
    }
  }

  /**
   * Executes a function with exponential backoff retry strategy.
   */
  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    let lastError: any;

    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastError = err;
        if (attempt < this.maxRetries) {
          const delay = this.initialDelayMs * Math.pow(this.backoffFactor, attempt - 1);
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }
    throw lastError;
  }
}

export default DistributionEngine;
