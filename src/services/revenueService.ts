import { OfferingRepository } from '../db/repositories/offeringRepository';
import {
    RevenueReportRepository,
    CreateRevenueReportInput,
    RevenueReport,
} from '../db/repositories/revenueReportRepository';
import { Errors } from '../lib/errors';
import { globalLogger } from '../lib/logger';

export interface SubmitRevenueReportInput {
    offeringId: string;
    issuerId: string;
    amount: string;
    periodStart: Date;
    periodEnd: Date;
}

export class RevenueService {
    constructor(
        private offeringRepo: OfferingRepository,
        private revenueReportRepo: RevenueReportRepository
    ) { }

    /**
     * @notice Submits and validates a revenue report for a specific offering.
     * @dev Hardened with production-grade validation for amounts and reporting periods.
     * 
     * Security Assumptions:
     * 1. The `issuerId` has been authenticated via JWT middleware.
     * 2. The `issuerId` is the primary owner of the `offeringId`.
     * 
     * Validation Rules:
     * - Amount must be a valid positive decimal string (max 10 decimal places).
     * - Period end date must be strictly after the start date.
     * - New reports cannot overlap with any existing reports for the same offering.
     * 
     * @param input - The revenue report data containing offering, amount, and period.
     * @returns The persisted RevenueReport object.
     * @throws Error if validation fails or unauthorized access is detected.
     */
    async submitReport(input: SubmitRevenueReportInput): Promise<RevenueReport> {
        // 1. Validate offering existence and ownership
        const offering = await this.offeringRepo.findById(input.offeringId);
        if (!offering) {
            throw Errors.notFound(`Offering ${input.offeringId} not found`);
        }

        if (offering.issuer_id !== input.issuerId) {
            throw Errors.forbidden(`Unauthorized: Issuer does not own offering ${input.offeringId}`);
        }

        // 2. Validate amount format and value
        const amountRegex = /^\d+(\.\d{1,10})?$/;
        if (!amountRegex.test(input.amount)) {
            throw Errors.validationError('Invalid revenue amount format: must be a positive decimal string (max 10 decimal places)');
        }

        const amountNum = parseFloat(input.amount);
        if (amountNum <= 0) {
            throw Errors.validationError('Invalid revenue amount: must be greater than zero');
        }

        // 3. Validate period logic
        if (input.periodEnd <= input.periodStart) {
            throw Errors.validationError('Invalid period: end date must be strictly after start date');
        }

        // 4. Enforce non-overlapping periods per offering
        const overlapping = await this.revenueReportRepo.findOverlappingReport(
            input.offeringId,
            input.periodStart,
            input.periodEnd
        );
      }
    } catch (error) {
      this.logger.warn('Invalid revenue amount format', { offeringId, amount, error: error instanceof Error ? error.message : String(error) });
      if (error instanceof AppError) throw error;
      throw new AppError(
        ErrorCode.VALIDATION_ERROR,
        `Invalid revenue amount: ${amount}`,
        400,
        { field: 'amount', value: amount }
      );
    }

    // 2. Validate period dates
    const startDate = new Date(periodStart);
    const endDate = new Date(periodEnd);

    if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
      throw new AppError(
        ErrorCode.VALIDATION_ERROR,
        'Invalid date format for periodStart or periodEnd. Must be ISO 8601.',
        400,
        { periodStart, periodEnd }
      );
    }

    if (startDate >= endDate) {
      throw new AppError(
        ErrorCode.VALIDATION_ERROR,
        'periodEnd must be after periodStart.',
        400,
        { periodStart, periodEnd }
      );
    }

    // 3. Convert amount to Soroban i128 scaled BigInt
    let amountI128: BigInt;
    try {
      amountI128 = decimalAmount.toSorobanI128(SOROBAN_I128_SCALE);
    } catch (error) {
      this.logger.error('Failed to convert decimal amount to Soroban i128', { offeringId, amount, error: error instanceof Error ? error.message : String(error) });
      if (error instanceof AppError) throw error;
      throw new AppError(
        ErrorCode.INTERNAL_ERROR,
        'Failed to process revenue amount for Soroban.',
        500,
        { offeringId, amount }
      );
    }

    // 4. Submit to Stellar/Soroban
    let transactionId: string;
    try {
      transactionId = await this.stellarService.submitRevenueToSoroban(
        offeringId,
        amountI128,
        startDate,
        endDate
      );
      this.logger.info('Revenue submitted to Soroban', { offeringId, amount, amountI128: amountI128.toString(), transactionId });
    } catch (error) {
      this.logger.error('Stellar RPC submission failed', { offeringId, amount, error: error instanceof Error ? error.message : String(error) });
      // Use a utility to classify Stellar RPC failures into AppErrors
      throw this.classifyStellarRPCFailure(error);
    }

        if (overlapping) {
            throw Errors.conflict(
                `A revenue report already exists that overlaps with the specified period (${input.periodStart.toISOString()} - ${input.periodEnd.toISOString()})`
            );
        }

        // 5. Persist report
        const report = await this.revenueReportRepo.create({
            offering_id: input.offeringId,
            issuer_id: input.issuerId,
            amount: input.amount,
            period_start: input.periodStart,
            period_end: input.periodEnd,
            reported_by: input.issuerId, // Assuming reporter is the issuer for now
        });

        // 6. Optionally emit event for distribution engine
        this.emitDistributionEvent(report);

        return report;
    }

    private emitDistributionEvent(report: RevenueReport) {
        // Placeholder for event emission logic
        // This could be a message to a queue (e.g., RabbitMQ, Kafka) or a PubSub system
        globalLogger.info(`Revenue report submitted for offering ${report.offering_id}. Triggering distribution engine...`, {
            reportId: report.id,
            offeringId: report.offering_id,
            amount: report.amount,
            periodStart: report.period_start,
            periodEnd: report.period_end,
        });
    }

    // Generic fallback for unclassified errors
    this.logger.error('Unclassified Stellar RPC error', { error });
    return new AppError(
      ErrorCode.INTERNAL_ERROR,
      'An unexpected error occurred while interacting with the Stellar network.',
      500
    );
  }
}