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
    requestId?: string;
}

/**
 * Decimal boundary limits for revenue amounts.
 * @dev Database schema uses NUMERIC(30,10) for amounts to preserve precision.
 *      This allows up to 20 integer digits and 10 decimal places (10^-10 cents minimum).
 */
const DECIMAL_LIMITS = {
    /** Maximum number of integer digits before decimal point */
    MAX_INTEGER_DIGITS: 20,
    /** Maximum number of fractional digits after decimal point */
    MAX_DECIMAL_PLACES: 10,
    /** Maximum representable amount (20 nines + decimal + 10 nines) */
    MAX_AMOUNT: '99999999999999999999.9999999999',
    /** Minimum positive amount (essentially 0.0000000001) */
    MIN_AMOUNT: '0.0000000001',
} as const;

/**
 * RevenueService: Business logic for revenue report submission and validation.
 *
 * Security Assumptions:
 * - The `issuerId` has been authenticated via JWT middleware before service invocation.
 * - The offering ownership check is performed before any state-modifying operations.
 * - Database transactions (if configured) provide ACID guarantees for concurrency safety.
 *
 * Validation Rules:
 * - Amount must be a positive decimal string with at most 10 decimal places (database NUMERIC precision).
 * - Period end must be strictly after period start (prevents zero-width or negative ranges).
 * - New reports cannot overlap with any existing report for the same offering.
 * - Amount cannot exceed 20 integer digits (prevents integer overflow in Stellar operations).
 *
 * @module services/revenueService
 */
export class RevenueService {
    private logger: Logger;

    constructor(
        private offeringRepo: OfferingRepository,
        private revenueReportRepo: RevenueReportRepository
    ) {
        this.logger = new Logger({ level: LogLevel.INFO });
    }

    /**
     * @notice Submits and validates a revenue report for a specific offering.
     * @dev Hardened with production-grade validation for amounts and reporting periods.
     * 
     * Decimal Precision:
     * - Database schema: NUMERIC(30,10) - supports up to 20 integer + 10 decimal places.
     * - Input validation: Rejects amounts exceeding these boundaries.
     * - String storage: Amounts stored as strings in JSON to preserve precision.
     * 
     * @param input - The revenue report data containing offering, amount, and period.
     * @returns The persisted RevenueReport object.
     * @throws AppError if validation fails or unauthorized access is detected.
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

        // ─── Check fractional part length ────────────────────────────────────────
        if (fractionalPart.length > DECIMAL_LIMITS.MAX_DECIMAL_PLACES) {
            return {
                valid: false,
                reason: `Decimal places exceed maximum ${DECIMAL_LIMITS.MAX_DECIMAL_PLACES} places`,
                details: {
                    provided: fractionalPart.length,
                    maximum: DECIMAL_LIMITS.MAX_DECIMAL_PLACES,
                    providedValue: amount,
                },
            };
        }

        // ─── Check numeric value > 0 ────────────────────────────────────────────
        const numValue = parseFloat(amount);
        if (!Number.isFinite(numValue) || numValue <= 0) {
            return {
                valid: false,
                reason: 'Amount must be a positive number greater than zero',
                details: { providedValue: amount },
            };
        }

        // ─── Check against explicit maximum ─────────────────────────────────────
        const maxNum = parseFloat(DECIMAL_LIMITS.MAX_AMOUNT);
        if (numValue > maxNum) {
            return {
                valid: false,
                reason: `Amount exceeds maximum allowed value of ${DECIMAL_LIMITS.MAX_AMOUNT}`,
                details: { providedValue: amount, maximum: DECIMAL_LIMITS.MAX_AMOUNT },
            };
        }

        return { valid: true };
    }

    private emitDistributionEvent(report: RevenueReport, requestId: string): void {
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