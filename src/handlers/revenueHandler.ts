import { Response, NextFunction } from 'express';
import { RevenueService } from '../services/revenueService';
import { AuthenticatedRequest } from '../middleware/auth';
import { Errors } from '../lib/errors';

export class RevenueHandler {
    constructor(private revenueService: RevenueService) { }

    /**
     * Handle POST /api/offerings/:id/revenue
     */
    submitReport = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
        try {
            const offeringId = req.params.id;
            const issuerId = req.user?.id;

            if (!issuerId) {
                return next(Errors.unauthorized('User not authenticated'));
            }

            const { amount, periodStart, periodEnd } = req.body;

            if (!amount || !periodStart || !periodEnd) {
                return next(Errors.validationError('Missing required fields: amount, periodStart, periodEnd'));
            }

            const report = await this.revenueService.submitReport({
                offeringId,
                issuerId,
                amount,
                periodStart: new Date(periodStart),
                periodEnd: new Date(periodEnd),
            });

            return res.status(201).json({
                message: 'Revenue report submitted successfully',
                data: report,
            });
        } catch (error) {
            next(error);
        }
    };
}
