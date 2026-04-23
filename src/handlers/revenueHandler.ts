import { Response, NextFunction } from 'express';
import { RevenueService } from '../services/revenueService';
import { AuthenticatedRequest } from '../middleware/auth';
import { AppError, Errors } from '../lib/errors';
import { Logger, LogLevel } from '../lib/logger';

/**
 * RevenueHandler: HTTP request handler for revenue reporting operations.
 *
 * Security Assumptions:
 * - The `issuerId` has been authenticated via JWT middleware.
 * - The `issuerId` is the primary owner of the offering in the database.
 * - Request body has been validated against schema (amount as decimal string, dates as ISO 8601).
 *
 * All errors are mapped to AppError instances to ensure:
 * - Structured error responses with machine-readable error codes.
 * - No raw database or service errors leak to clients.
 * - Proper HTTP status codes and security classification.
 *
 * @module handlers/revenueHandler
 */
export class RevenueHandler {
    private logger: Logger;

    constructor(private revenueService: RevenueService) {
        this.logger = new Logger({ level: LogLevel.INFO });
    }

    /**
     * Handle POST /offerings/:id/revenue
     *
     * Submits a revenue report for a specific offering.
     *
     * @param req - Authenticated request with offering ID in path and report data in body.
     * @param res - HTTP response object.
     * @param next - Express error handler middleware callback.
     * @returns 201 with report payload on success; error response otherwise.
     *
     * Error Responses:
     * - 400: Validation error (missing/malformed fields)
     * - 401: User not authenticated
     * - 403: User does not own the offering
     * - 404: Offering not found
     * - 409: Period overlaps with existing report
     * - 500: Internal server error (never exposes details to client)
     */
    submitReport = async (
        req: AuthenticatedRequest,
        res: Response,
        next: NextFunction,
    ): Promise<void> => {
        try {
            const requestId = req.requestId;
            const offeringId = req.params.id;
            const issuerId = req.user?.id;

            // Ensure user is authenticated
            if (!issuerId) {
                this.logger.warn('Revenue submission attempt without authentication', {
                    requestId,
                    offeringId,
                });
                throw Errors.unauthorized('User not authenticated');
            }

            const { amount, periodStart, periodEnd } = req.body;

            // Validate required fields (schema middleware should catch this, but be defensive)
            if (!amount || !periodStart || !periodEnd) {
                this.logger.warn('Revenue submission missing required fields', {
                    requestId,
                    offeringId,
                    issuerId,
                    providedFields: { amount: !!amount, periodStart: !!periodStart, periodEnd: !!periodEnd },
                });
                throw Errors.badRequest('Missing required fields: amount, periodStart, periodEnd');
            }

            this.logger.info('Processing revenue report submission', {
                requestId,
                offeringId,
                issuerId,
                amount,
                periodStart,
                periodEnd,
            });

            // Submit the report via service (performs business logic validation)
            const report = await this.revenueService.submitReport({
                offeringId,
                issuerId,
                amount,
                periodStart: new Date(periodStart),
                periodEnd: new Date(periodEnd),
                requestId,
            });

            this.logger.info('Revenue report submitted successfully', {
                requestId,
                reportId: report.id,
                offeringId,
                issuerId,
            });

            res.status(201).json({
                message: 'Revenue report submitted successfully',
                data: report,
            });
        } catch (error: unknown) {
            if (error instanceof AppError) {
                // Already a structured error, pass to error handler
                this.logger.warn('Revenue submission validation error', {
                    requestId: req.requestId,
                    errorCode: error.code,
                    message: error.message,
                });
                next(error);
            } else {
                // Unexpected error, sanitize and pass to error handler
                this.logger.error('Unexpected error during revenue submission', {
                    requestId: req.requestId,
                    error: error instanceof Error ? error.message : String(error),
                });
                next(Errors.internal('An unexpected error occurred during revenue submission'));
            }
        }
    };

    /**
     * Handle POST /revenue-reports (alternative endpoint with offering ID in body)
     *
     * Submits a revenue report with offering identified by body field.
     *
     * @param req - Authenticated request with report data in body.
     * @param res - HTTP response object.
     * @param next - Express error handler middleware callback.
     * @returns 201 with report payload on success; error response otherwise.
     */
    submitReportByBody = async (
        req: AuthenticatedRequest,
        res: Response,
        next: NextFunction,
    ): Promise<void> => {
        try {
            const requestId = req.requestId;
            const issuerId = req.user?.id;

            if (!issuerId) {
                this.logger.warn('Revenue submission attempt without authentication', { requestId });
                throw Errors.unauthorized('User not authenticated');
            }

            const { offeringId, amount, periodStart, periodEnd } = req.body;

            if (!offeringId || !amount || !periodStart || !periodEnd) {
                this.logger.warn('Revenue submission missing required fields', {
                    requestId,
                    issuerId,
                    providedFields: {
                        offeringId: !!offeringId,
                        amount: !!amount,
                        periodStart: !!periodStart,
                        periodEnd: !!periodEnd,
                    },
                });
                throw Errors.badRequest('Missing required fields: offeringId, amount, periodStart, periodEnd');
            }

            this.logger.info('Processing revenue report submission (body-based)', {
                requestId,
                offeringId,
                issuerId,
                amount,
                periodStart,
                periodEnd,
            });

            const report = await this.revenueService.submitReport({
                offeringId,
                issuerId,
                amount,
                periodStart: new Date(periodStart),
                periodEnd: new Date(periodEnd),
                requestId,
            });

            this.logger.info('Revenue report submitted successfully (body-based)', {
                requestId,
                reportId: report.id,
                offeringId,
                issuerId,
            });

            res.status(201).json({
                message: 'Revenue report submitted successfully',
                data: report,
            });
        } catch (error: unknown) {
            if (error instanceof AppError) {
                this.logger.warn('Revenue submission validation error', {
                    requestId: req.requestId,
                    errorCode: error.code,
                    message: error.message,
                });
                next(error);
            } else {
                this.logger.error('Unexpected error during revenue submission', {
                    requestId: req.requestId,
                    error: error instanceof Error ? error.message : String(error),
                });
                next(Errors.internal('An unexpected error occurred during revenue submission'));
            }
        }
    };
}
