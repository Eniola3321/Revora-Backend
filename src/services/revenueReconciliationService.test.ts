/**
 * Revenue Reconciliation Service Tests
 * 
 * Comprehensive test suite for revenue reconciliation with chain event validation,
 * structured logging, and Stellar RPC failure classification.
 */

import { RevenueReconciliationService, ReconciliationOptions } from './revenueReconciliationService';
import { RevenueReportRepository } from '../db/repositories/revenueReportRepository';
import { DistributionRepository, DistributionRun } from '../db/repositories/distributionRepository';
import { InvestmentRepository, Investment } from '../db/repositories/investmentRepository';
import { Logger, LogLevel } from '../lib/logger';
import { StellarRPCFailureClass, classifyStellarRPCFailure } from '../lib/stellarRpcFailure';
import { Pool } from 'pg';

// Mock implementations
const mockDb = {} as Pool;
const mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
} as unknown as Logger;

const mockRevenueReportRepo = {
  listByOffering: jest.fn(),
} as unknown as RevenueReportRepository;

const mockDistributionRepo = {
  listByOffering: jest.fn(),
} as unknown as DistributionRepository;

const mockInvestmentRepo = {
  findByOffering: jest.fn(),
} as unknown as InvestmentRepository;

// Mock the repositories to be returned by constructors
jest.mock('../db/repositories/revenueReportRepository', () => ({
  RevenueReportRepository: jest.fn().mockImplementation(() => mockRevenueReportRepo),
}));

jest.mock('../db/repositories/distributionRepository', () => ({
  DistributionRepository: jest.fn().mockImplementation(() => mockDistributionRepo),
}));

jest.mock('../db/repositories/investmentRepository', () => ({
  InvestmentRepository: jest.fn().mockImplementation(() => mockInvestmentRepo),
}));

describe('RevenueReconciliationService', () => {
  let service: RevenueReconciliationService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new RevenueReconciliationService(mockDb, mockLogger);
  });

  describe('reconcile', () => {
    const offeringId = 'offering-123';
    const periodStart = new Date('2024-01-01');
    const periodEnd = new Date('2024-01-31');

    const mockRevenueReports = [
      {
        id: 'report-1',
        offering_id: offeringId,
        amount: '1000.00',
        period_start: periodStart,
        period_end: periodEnd,
      },
    ];

    const mockDistributionRuns: DistributionRun[] = [
      {
        id: 'run-1',
        offering_id: offeringId,
        total_amount: '1000.00',
        status: 'completed',
        distribution_date: new Date('2024-01-15'),
        stellar_transaction_hash: 'tx-hash-123',
      },
    ];

    const mockInvestments: Investment[] = [
      {
        id: 'investment-1',
        offering_id: offeringId,
        investor_id: 'investor-1',
        amount: '200.00',
        status: 'completed',
      },
    ];

    it('should perform successful reconciliation with basic options', async () => {
      (mockRevenueReportRepo.listByOffering as jest.Mock).mockResolvedValue(mockRevenueReports);
      (mockDistributionRepo.listByOffering as jest.Mock).mockResolvedValue(mockDistributionRuns);
      (mockInvestmentRepo.findByOffering as jest.Mock).mockResolvedValue(mockInvestments);

      const result = await service.reconcile(offeringId, periodStart, periodEnd);

      expect(result).toEqual({
        offeringId,
        periodStart,
        periodEnd,
        isBalanced: true,
        discrepancies: [],
        summary: {
          totalRevenueReported: '1000.00',
          totalPayouts: '1000.00',
          discrepancyAmount: '0.00',
          investorCount: 1,
          payoutsProcessed: 1,
          payoutsFailed: 0,
        },
        checkedAt: expect.any(Date),
      });

      // Verify logging calls
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Starting reconciliation process',
        expect.objectContaining({
          offeringId,
          periodStart,
          periodEnd,
        }),
        LogLevel.INFO
      );

      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Fetched data for reconciliation',
        expect.objectContaining({
          offeringId,
          revenueReportsCount: 1,
          relevantReportsCount: 1,
          distributionRunsCount: 1,
          relevantRunsCount: 1,
        }),
        LogLevel.DEBUG
      );

      expect(mockLogger.info).toHaveBeenCalledWith(
        'Reconciliation completed',
        expect.objectContaining({
          offeringId,
          isBalanced: true,
          discrepanciesCount: 0,
        }),
        LogLevel.INFO
      );
    });

    it('should detect revenue mismatch discrepancies', async () => {
      const mismatchedRuns: DistributionRun[] = [
        {
          ...mockDistributionRuns[0],
          total_amount: '950.00', // Less than revenue
        },
      ];

      (mockRevenueReportRepo.listByOffering as jest.Mock).mockResolvedValue(mockRevenueReports);
      (mockDistributionRepo.listByOffering as jest.Mock).mockResolvedValue(mismatchedRuns);
      (mockInvestmentRepo.findByOffering as jest.Mock).mockResolvedValue(mockInvestments);

      const result = await service.reconcile(offeringId, periodStart, periodEnd);

      expect(result.isBalanced).toBe(false);
      expect(result.discrepancies).toHaveLength(1);
      expect(result.discrepancies[0].type).toBe('REVENUE_MISMATCH');
      expect(result.discrepancies[0].severity).toBe('error');
    });

    it('should perform chain event validation when enabled', async () => {
      const options: ReconciliationOptions = {
        validateChainEvents: true,
      };

      (mockRevenueReportRepo.listByOffering as jest.Mock).mockResolvedValue(mockRevenueReports);
      (mockDistributionRepo.listByOffering as jest.Mock).mockResolvedValue(mockDistributionRuns);
      (mockInvestmentRepo.findByOffering as jest.Mock).mockResolvedValue(mockInvestments);

      const result = await service.reconcile(offeringId, periodStart, periodEnd, options);

      expect(result.discrepancies).toHaveLength(0); // Should pass with mock success

      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Starting chain event consistency validation',
        expect.objectContaining({
          offeringId,
          runsCount: 1,
        }),
        LogLevel.DEBUG
      );
    });

    it('should handle Stellar transaction hash missing', async () => {
      const runWithoutTxHash: DistributionRun[] = [
        {
          ...mockDistributionRuns[0],
          stellar_transaction_hash: undefined,
        },
      ];

      const options: ReconciliationOptions = {
        validateChainEvents: true,
      };

      (mockRevenueReportRepo.listByOffering as jest.Mock).mockResolvedValue(mockRevenueReports);
      (mockDistributionRepo.listByOffering as jest.Mock).mockResolvedValue(runWithoutTxHash);
      (mockInvestmentRepo.findByOffering as jest.Mock).mockResolvedValue(mockInvestments);

      const result = await service.reconcile(offeringId, periodStart, periodEnd, options);

      expect(result.isBalanced).toBe(false);
      expect(result.discrepancies).toHaveLength(1);
      expect(result.discrepancies[0].type).toBe('STELLAR_TX_NOT_FOUND');
      expect(result.discrepancies[0].severity).toBe('error');
    });

    it('should handle Stellar RPC timeout failures', async () => {
      // Mock the validateStellarTransaction method to throw timeout
      const originalValidateChainEvent = service['validateChainEventConsistency'];
      service['validateChainEventConsistency'] = jest.fn().mockImplementation(async () => {
        const timeoutError = new Error('Request timeout');
        timeoutError.name = 'AbortError';
        throw timeoutError;
      });

      const options: ReconciliationOptions = {
        validateChainEvents: true,
      };

      (mockRevenueReportRepo.listByOffering as jest.Mock).mockResolvedValue(mockRevenueReports);
      (mockDistributionRepo.listByOffering as jest.Mock).mockResolvedValue(mockDistributionRuns);
      (mockInvestmentRepo.findByOffering as jest.Mock).mockResolvedValue(mockInvestments);

      const result = await service.reconcile(offeringId, periodStart, periodEnd, options);

      expect(result.discrepancies).toHaveLength(1);
      expect(result.discrepancies[0].type).toBe('CHAIN_EVENT_VALIDATION_FAILED');
      expect(result.discrepancies[0].severity).toBe('warning');

      // Restore original method
      service['validateChainEventConsistency'] = originalValidateChainEvent;
    });

    it('should handle Stellar RPC rate limit failures', async () => {
      service['validateChainEventConsistency'] = jest.fn().mockImplementation(async () => {
        const rateLimitError = { status: 429 };
        throw rateLimitError;
      });

      const options: ReconciliationOptions = {
        validateChainEvents: true,
      };

      (mockRevenueReportRepo.listByOffering as jest.Mock).mockResolvedValue(mockRevenueReports);
      (mockDistributionRepo.listByOffering as jest.Mock).mockResolvedValue(mockDistributionRuns);
      (mockInvestmentRepo.findByOffering as jest.Mock).mockResolvedValue(mockInvestments);

      const result = await service.reconcile(offeringId, periodStart, periodEnd, options);

      expect(result.discrepancies).toHaveLength(1);
      expect(result.discrepancies[0].type).toBe('CHAIN_EVENT_VALIDATION_FAILED');
      expect(result.discrepancies[0].severity).toBe('warning');
    });

    it('should perform investor allocation checks when enabled', async () => {
      const options: ReconciliationOptions = {
        checkInvestorAllocations: true,
      };

      (mockRevenueReportRepo.listByOffering as jest.Mock).mockResolvedValue(mockRevenueReports);
      (mockDistributionRepo.listByOffering as jest.Mock).mockResolvedValue(mockDistributionRuns);
      (mockInvestmentRepo.findByOffering as jest.Mock).mockResolvedValue(mockInvestments);

      const result = await service.reconcile(offeringId, periodStart, periodEnd, options);

      expect(result.discrepancies).toHaveLength(0); // Should pass with valid data
    });

    it('should perform rounding adjustment checks when enabled', async () => {
      const options: ReconciliationOptions = {
        checkRoundingAdjustments: true,
      };

      (mockRevenueReportRepo.listByOffering as jest.Mock).mockResolvedValue(mockRevenueReports);
      (mockDistributionRepo.listByOffering as jest.Mock).mockResolvedValue(mockDistributionRuns);
      (mockInvestmentRepo.findByOffering as jest.Mock).mockResolvedValue(mockInvestments);

      const result = await service.reconcile(offeringId, periodStart, periodEnd, options);

      expect(result.discrepancies).toHaveLength(0); // Should pass with clean amounts
    });

    it('should handle individual check failures gracefully', async () => {
      // Mock distribution run integrity check to fail
      const originalCheckIntegrity = service['checkDistributionRunIntegrity'];
      service['checkDistributionRunIntegrity'] = jest.fn().mockRejectedValue(new Error('Database error'));

      (mockRevenueReportRepo.listByOffering as jest.Mock).mockResolvedValue(mockRevenueReports);
      (mockDistributionRepo.listByOffering as jest.Mock).mockResolvedValue(mockDistributionRuns);
      (mockInvestmentRepo.findByOffering as jest.Mock).mockResolvedValue(mockInvestments);

      const result = await service.reconcile(offeringId, periodStart, periodEnd);

      expect(result.discrepancies).toHaveLength(1);
      expect(result.discrepancies[0].type).toBe('DISTRIBUTION_STATUS_INVALID');
      expect(result.discrepancies[0].severity).toBe('error');

      expect(mockLogger.error).toHaveBeenCalledWith(
        'Failed to check distribution run integrity',
        expect.objectContaining({
          offeringId,
          runId: 'run-1',
        }),
        LogLevel.ERROR
      );

      // Restore original method
      service['checkDistributionRunIntegrity'] = originalCheckIntegrity;
    });

    it('should handle complete reconciliation process failure', async () => {
      (mockRevenueReportRepo.listByOffering as jest.Mock).mockRejectedValue(new Error('Database connection failed'));

      await expect(service.reconcile(offeringId, periodStart, periodEnd)).rejects.toThrow();

      expect(mockLogger.error).toHaveBeenCalledWith(
        'Reconciliation process failed',
        expect.objectContaining({
          offeringId,
        }),
        LogLevel.ERROR
      );
    });
  });

  describe('quickBalanceCheck', () => {
    it('should perform quick balance check successfully', async () => {
      const offeringId = 'offering-123';
      const periodStart = new Date('2024-01-01');
      const periodEnd = new Date('2024-01-31');

      const mockRevenueReports = [
        {
          id: 'report-1',
          offering_id: offeringId,
          amount: '1000.00',
          period_start: periodStart,
          period_end: periodEnd,
        },
      ];

      const mockDistributionRuns = [
        {
          id: 'run-1',
          offering_id: offeringId,
          total_amount: '1000.00',
          status: 'completed',
          distribution_date: new Date('2024-01-15'),
        },
      ];

      (mockRevenueReportRepo.listByOffering as jest.Mock).mockResolvedValue(mockRevenueReports);
      (mockDistributionRepo.listByOffering as jest.Mock).mockResolvedValue(mockDistributionRuns);

      const result = await service.quickBalanceCheck(offeringId, periodStart, periodEnd);

      expect(result).toEqual({
        isBalanced: true,
        difference: '0.00',
      });
    });

    it('should detect imbalance in quick check', async () => {
      const offeringId = 'offering-123';
      const periodStart = new Date('2024-01-01');
      const periodEnd = new Date('2024-01-31');

      const mockRevenueReports = [
        {
          id: 'report-1',
          offering_id: offeringId,
          amount: '1000.00',
          period_start: periodStart,
          period_end: periodEnd,
        },
      ];

      const mockDistributionRuns = [
        {
          id: 'run-1',
          offering_id: offeringId,
          total_amount: '950.00', // Less than revenue
          status: 'completed',
          distribution_date: new Date('2024-01-15'),
        },
      ];

      (mockRevenueReportRepo.listByOffering as jest.Mock).mockResolvedValue(mockRevenueReports);
      (mockDistributionRepo.listByOffering as jest.Mock).mockResolvedValue(mockDistributionRuns);

      const result = await service.quickBalanceCheck(offeringId, periodStart, periodEnd);

      expect(result).toEqual({
        isBalanced: false,
        difference: '50.00',
      });
    });
  });

  describe('verifyDistributionRun', () => {
    it('should verify valid distribution run', async () => {
      const mockRuns = [
        {
          id: 'run-123',
          offering_id: 'offering-123',
          total_amount: '1000.00',
          status: 'completed',
          distribution_date: new Date('2024-01-15'),
        },
      ];

      (mockDistributionRepo.listByOffering as jest.Mock).mockResolvedValue(mockRuns);

      const result = await service.verifyDistributionRun('run-123');

      expect(result).toEqual({
        isValid: true,
        errors: [],
      });
    });

    it('should reject distribution run with invalid status', async () => {
      const mockRuns = [
        {
          id: 'run-123',
          offering_id: 'offering-123',
          total_amount: '1000.00',
          status: 'failed',
          distribution_date: new Date('2024-01-15'),
        },
      ];

      (mockDistributionRepo.listByOffering as jest.Mock).mockResolvedValue(mockRuns);

      const result = await service.verifyDistributionRun('run-123');

      expect(result).toEqual({
        isValid: false,
        errors: ['Invalid distribution status: failed'],
      });
    });

    it('should reject distribution run with negative amount', async () => {
      const mockRuns = [
        {
          id: 'run-123',
          offering_id: 'offering-123',
          total_amount: '-100.00',
          status: 'completed',
          distribution_date: new Date('2024-01-15'),
        },
      ];

      (mockDistributionRepo.listByOffering as jest.Mock).mockResolvedValue(mockRuns);

      const result = await service.verifyDistributionRun('run-123');

      expect(result).toEqual({
        isValid: false,
        errors: ['Total amount cannot be negative'],
      });
    });

    it('should handle distribution run not found', async () => {
      (mockDistributionRepo.listByOffering as jest.Mock).mockResolvedValue([]);

      const result = await service.verifyDistributionRun('nonexistent-run');

      expect(result).toEqual({
        isValid: false,
        errors: ['Distribution run not found'],
      });
    });
  });

  describe('validateRevenueReport', () => {
    it('should validate valid revenue report', async () => {
      const offeringId = 'offering-123';
      const amount = '1000.00';
      const periodStart = new Date('2024-01-01');
      const periodEnd = new Date('2024-01-31');

      (mockRevenueReportRepo.findByOfferingAndPeriod as jest.Mock).mockResolvedValue(null);

      const result = await service.validateRevenueReport(offeringId, amount, periodStart, periodEnd);

      expect(result).toEqual({
        isValid: true,
        errors: [],
      });
    });

    it('should reject negative revenue amounts', async () => {
      const offeringId = 'offering-123';
      const amount = '-100.00';
      const periodStart = new Date('2024-01-01');
      const periodEnd = new Date('2024-01-31');

      const result = await service.validateRevenueReport(offeringId, amount, periodStart, periodEnd);

      expect(result).toEqual({
        isValid: false,
        errors: ['Revenue amount cannot be negative'],
      });
    });

    it('should reject invalid period dates', async () => {
      const offeringId = 'offering-123';
      const amount = '1000.00';
      const periodStart = new Date('2024-01-31');
      const periodEnd = new Date('2024-01-01'); // End before start

      const result = await service.validateRevenueReport(offeringId, amount, periodStart, periodEnd);

      expect(result).toEqual({
        isValid: false,
        errors: ['Period end must be after period start'],
      });
    });

    it('should reject future period start', async () => {
      const offeringId = 'offering-123';
      const amount = '1000.00';
      const periodStart = new Date(Date.now() + 86400000); // Tomorrow
      const periodEnd = new Date(Date.now() + 86400000 * 2);

      const result = await service.validateRevenueReport(offeringId, amount, periodStart, periodEnd);

      expect(result).toEqual({
        isValid: false,
        errors: ['Period start cannot be in the future'],
      });
    });

    it('should reject duplicate revenue reports', async () => {
      const offeringId = 'offering-123';
      const amount = '1000.00';
      const periodStart = new Date('2024-01-01');
      const periodEnd = new Date('2024-01-31');

      const existingReport = {
        id: 'report-123',
        offering_id: offeringId,
        amount: '1000.00',
        period_start: periodStart,
        period_end: periodEnd,
      };

      (mockRevenueReportRepo.findByOfferingAndPeriod as jest.Mock).mockResolvedValue(existingReport);

      const result = await service.validateRevenueReport(offeringId, amount, periodStart, periodEnd);

      expect(result).toEqual({
        isValid: false,
        errors: ['Revenue report already exists for this offering and period'],
      });
    });
  });

  describe('validateStellarTransaction', () => {
    it('should validate successful transaction', async () => {
      const txHash = 'tx-hash-123';
      const expectedAmount = '1000.00';

      // Mock Math.random to return high value for success
      const originalRandom = Math.random;
      Math.random = jest.fn().mockReturnValue(0.8);

      const result = await service['validateStellarTransaction'](txHash, expectedAmount);

      expect(result).toEqual({
        isValid: true,
        actualAmount: expectedAmount,
        timestamp: expect.any(String),
      });

      // Restore original Math.random
      Math.random = originalRandom;
    });

    it('should handle transaction timeout', async () => {
      const txHash = 'tx-hash-123';
      const expectedAmount = '1000.00';

      // Mock Math.random to return low value for timeout
      const originalRandom = Math.random;
      Math.random = jest.fn().mockReturnValue(0.05);

      await expect(service['validateStellarTransaction'](txHash, expectedAmount)).rejects.toThrow('Request timeout');

      // Restore original Math.random
      Math.random = originalRandom;
    });

    it('should handle rate limit', async () => {
      const txHash = 'tx-hash-123';
      const expectedAmount = '1000.00';

      // Mock Math.random to return value for rate limit
      const originalRandom = Math.random;
      Math.random = jest.fn().mockReturnValue(0.12);

      await expect(service['validateStellarTransaction'](txHash, expectedAmount)).rejects.toEqual({ status: 429 });

      // Restore original Math.random
      Math.random = originalRandom;
    });

    it('should handle transaction not found', async () => {
      const txHash = 'tx-hash-123';
      const expectedAmount = '1000.00';

      // Mock Math.random to return value for not found
      const originalRandom = Math.random;
      Math.random = jest.fn().mockReturnValue(0.18);

      const result = await service['validateStellarTransaction'](txHash, expectedAmount);

      expect(result).toEqual({
        isValid: false,
        errors: ['Transaction not found on chain'],
      });

      // Restore original Math.random
      Math.random = originalRandom;
    });

    it('should handle amount mismatch', async () => {
      const txHash = 'tx-hash-123';
      const expectedAmount = '1000.00';

      // Mock Math.random to return value for amount mismatch
      const originalRandom = Math.random;
      Math.random = jest.fn().mockReturnValue(0.22);

      const result = await service['validateStellarTransaction'](txHash, expectedAmount);

      expect(result).toEqual({
        isValid: false,
        actualAmount: '950.00',
        errors: ['Transaction amount does not match expected distribution amount'],
      });

      // Restore original Math.random
      Math.random = originalRandom;
    });
  });

  describe('Stellar RPC Failure Classification Integration', () => {
    it('should classify timeout errors correctly in chain validation', async () => {
      service['validateChainEventConsistency'] = jest.fn().mockImplementation(async () => {
        const timeoutError = new Error('Request timeout');
        timeoutError.name = 'AbortError';
        throw timeoutError;
      });

      const options: ReconciliationOptions = {
        validateChainEvents: true,
      };

      (mockRevenueReportRepo.listByOffering as jest.Mock).mockResolvedValue([]);
      (mockDistributionRepo.listByOffering as jest.Mock).mockResolvedValue([]);
      (mockInvestmentRepo.findByOffering as jest.Mock).mockResolvedValue([]);

      const result = await service.reconcile('offering-123', new Date(), new Date(), options);

      expect(result.discrepancies).toHaveLength(1);
      expect(result.discrepancies[0].type).toBe('CHAIN_EVENT_VALIDATION_FAILED');
      expect(result.discrepancies[0].severity).toBe('warning');

      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Failed to validate chain event consistency',
        expect.objectContaining({
          failureClass: StellarRPCFailureClass.TIMEOUT,
        }),
        LogLevel.WARN
      );
    });

    it('should classify rate limit errors correctly', async () => {
      service['validateChainEventConsistency'] = jest.fn().mockImplementation(async () => {
        const rateLimitError = { status: 429 };
        throw rateLimitError;
      });

      const options: ReconciliationOptions = {
        validateChainEvents: true,
      };

      (mockRevenueReportRepo.listByOffering as jest.Mock).mockResolvedValue([]);
      (mockDistributionRepo.listByOffering as jest.Mock).mockResolvedValue([]);
      (mockInvestmentRepo.findByOffering as jest.Mock).mockResolvedValue([]);

      const result = await service.reconcile('offering-123', new Date(), new Date(), options);

      expect(result.discrepancies).toHaveLength(1);
      expect(result.discrepancies[0].details.failureClass).toBe(StellarRPCFailureClass.RATE_LIMIT);
    });
  });
});
