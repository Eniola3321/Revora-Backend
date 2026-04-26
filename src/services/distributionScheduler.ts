import { Logger, globalLogger } from '../lib/logger';
import { DistributionEngine } from './distributionEngine';
import { RevenueReportRepository } from '../db/repositories/revenueReportRepository';
import { AppError, Errors } from '../lib/errors';
import { classifyStellarRPCFailure } from '../lib/stellarRpcFailure';

export interface DistributionSchedulerOptions {
  logger?: Logger;
}

/**
 * @title DistributionScheduler
 * @notice Automates the execution of distributions based on approved revenue reports.
 * @dev This service scans for approved revenue reports that haven't been successfully distributed
 * and triggers the DistributionEngine for each.
 */
export class DistributionScheduler {
  private readonly logger: Logger;

  constructor(
    private readonly distributionEngine: DistributionEngine,
    private readonly revenueReportRepo: RevenueReportRepository,
    options: DistributionSchedulerOptions = {}
  ) {
    this.logger = options.logger ?? globalLogger;
  }

  /**
   * Scans for pending distributions and processes them.
   * @returns A summary of the processing run.
   */
  async processPendingDistributions(): Promise<{
    processed: number;
    successful: number;
    failed: number;
    errors: Array<{ reportId: string; error: string }>;
  }> {
    this.logger.info('Starting automated distribution processing');
    
    const pendingReports = await this.revenueReportRepo.findApprovedWithoutDistribution();
    
    this.logger.info(`Found ${pendingReports.length} pending reports for distribution`);

    const summary = {
      processed: pendingReports.length,
      successful: 0,
      failed: 0,
      errors: [] as Array<{ reportId: string; error: string }>,
    };

    for (const report of pendingReports) {
      try {
        if (!report.period_start || !report.period_end || !report.amount) {
          throw Errors.badRequest(`Report ${report.id} is missing critical data (period or amount)`);
        }

        this.logger.info('Processing automated distribution', {
          reportId: report.id,
          offeringId: report.offering_id,
          amount: report.amount,
        });

        await this.distributionEngine.distribute(
          report.offering_id,
          {
            id: report.id,
            start: report.period_start,
            end: report.period_end,
          },
          Number(report.amount)
        );

        summary.successful++;
        this.logger.info('Automated distribution successful', {
          reportId: report.id,
          offeringId: report.offering_id,
        });
      } catch (err) {
        summary.failed++;
        
        const failure = classifyStellarRPCFailure(err, {
          operation: 'automatedDistribution',
          offeringId: report.offering_id,
          periodId: report.id,
        });

        // Use a safe error message for the summary
        const safeError = `Distribution failed: ${failure.class}`;
          
        summary.errors.push({ reportId: report.id, error: safeError });
        
        this.logger.error('Automated distribution failed', {
          reportId: report.id,
          offeringId: report.offering_id,
          error: err instanceof Error ? err.message : String(err),
          failureClass: failure.class,
          isAppError: err instanceof AppError,
        });
      }
    }

    this.logger.info('Automated distribution processing complete', summary);
    return summary;
  }
}
