/**
 * Reconciliation Routes Tests
 * 
 * Comprehensive test suite for reconciliation API endpoints with audit logging,
 * structured logging, and Stellar RPC failure classification.
 */

import request from 'supertest';
import { Router } from 'express';
import { Pool } from 'pg';
import { createReconciliationRouter, ReconciliationRequest } from './reconciliationRoutes';
import { RevenueReconciliationService } from '../services/revenueReconciliationService';
import { AuditLogRepository } from '../db/repositories/auditLogRepository';
import { Logger, LogLevel } from '../lib/logger';
import { Errors } from '../lib/errors';
import { StellarRPCFailureClass, classifyStellarRPCFailure } from '../lib/stellarRpcFailure';

// Mock implementations
const mockDb = {} as Pool;
const mockOfferingRepo = {
  findById: jest.fn(),
  getById: jest.fn(),
};
const mockAuditLogRepo = {
  createAuditLog: jest.fn(),
} as unknown as AuditLogRepository;
const mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
} as unknown as Logger;

const mockReconciliationService = {
  reconcile: jest.fn(),
  quickBalanceCheck: jest.fn(),
  verifyDistributionRun: jest.fn(),
  validateRevenueReport: jest.fn(),
} as unknown as RevenueReconciliationService;

const mockRequireAuth = (req: any, res: any, next: any) => {
  req.user = {
    id: 'test-user-id',
    role: 'startup',
    sessionToken: 'test-token',
  };
  req.requestId = 'test-request-id';
  next();
};

describe('ReconciliationRoutes', () => {
  let app: Router;

  beforeEach(() => {
    jest.clearAllMocks();
    
    app = createReconciliationRouter({
      db: mockDb,
      offeringRepo: mockOfferingRepo,
      auditLogRepo: mockAuditLogRepo,
      logger: mockLogger,
      requireAuth: mockRequireAuth,
    });
  });

  describe('POST /reconcile', () => {
    const validReconcileData = {
      offeringId: 'offering-123',
      periodStart: '2024-01-01T00:00:00Z',
      periodEnd: '2024-01-31T23:59:59Z',
      options: { tolerance: 0.01 },
    };

    it('should perform successful reconciliation with audit logging', async () => {
      // Mock offering authorization check
      (mockOfferingRepo.findById as jest.Mock).mockResolvedValue({
        id: 'offering-123',
        issuer_user_id: 'test-user-id',
      });

      // Mock reconciliation service
      const mockResult = {
        offeringId: 'offering-123',
        periodStart: new Date('2024-01-01'),
        periodEnd: new Date('2024-01-31'),
        isBalanced: true,
        discrepancies: [],
        summary: {
          totalRevenueReported: '1000.00',
          totalPayouts: '1000.00',
          discrepancyAmount: '0.00',
          investorCount: 5,
          payoutsProcessed: 5,
          payoutsFailed: 0,
        },
        checkedAt: new Date(),
      };
      (mockReconciliationService.reconcile as jest.Mock).mockResolvedValue(mockResult);

      // Mock audit log creation
      (mockAuditLogRepo.createAuditLog as jest.Mock).mockResolvedValue({
        id: 'audit-log-123',
        user_id: 'test-user-id',
        action: 'RECONCILIATION_PERFORMED',
        resource: 'offering:offering-123',
        created_at: new Date(),
      });

      const response = await request(app)
        .post('/reconcile')
        .send(validReconcileData)
        .expect(200);

      expect(response.body).toEqual({
        success: true,
        data: mockResult,
      });

      // Verify audit log was created
      expect(mockAuditLogRepo.createAuditLog).toHaveBeenCalledWith({
        user_id: 'test-user-id',
        action: 'RECONCILIATION_PERFORMED',
        resource: 'offering:offering-123',
        details: JSON.stringify({
          periodStart: '2024-01-01T00:00:00Z',
          periodEnd: '2024-01-31T23:59:59Z',
          discrepanciesFound: 0,
          isBalanced: true,
          totalRevenue: '1000.00',
          totalPayouts: '1000.00',
        }),
        ip_address: expect.any(String),
        user_agent: expect.any(String),
      });

      // Verify structured logging
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Starting reconciliation process',
        expect.objectContaining({
          requestId: 'test-request-id',
          userId: 'test-user-id',
          offeringId: 'offering-123',
        }),
        LogLevel.INFO
      );

      expect(mockLogger.info).toHaveBeenCalledWith(
        'Reconciliation completed successfully',
        expect.objectContaining({
          requestId: 'test-request-id',
          userId: 'test-user-id',
          offeringId: 'offering-123',
          isBalanced: true,
          discrepanciesCount: 0,
        }),
        LogLevel.INFO
      );
    });

    it('should handle validation errors', async () => {
      const invalidData = {
        offeringId: '', // Invalid empty string
        periodStart: '2024-01-01',
        periodEnd: '2024-01-31',
      };

      const response = await request(app)
        .post('/reconcile')
        .send(invalidData)
        .expect(400);

      expect(response.body.code).toBe('VALIDATION_ERROR');
      expect(mockLogger.error).toHaveBeenCalledWith(
        'Reconciliation failed',
        expect.objectContaining({
          requestId: 'test-request-id',
          userId: 'test-user-id',
        }),
        LogLevel.ERROR
      );
    });

    it('should handle authorization errors', async () => {
      (mockOfferingRepo.findById as jest.Mock).mockResolvedValue({
        id: 'offering-123',
        issuer_user_id: 'different-user-id', // Different owner
      });

      const response = await request(app)
        .post('/reconcile')
        .send(validReconcileData)
        .expect(403);

      expect(response.body.code).toBe('FORBIDDEN');
    });

    it('should handle Stellar RPC failures', async () => {
      (mockOfferingRepo.findById as jest.Mock).mockResolvedValue({
        id: 'offering-123',
        issuer_user_id: 'test-user-id',
      });

      const stellarError = new Error('Stellar RPC timeout');
      (mockReconciliationService.reconcile as jest.Mock).mockRejectedValue(stellarError);

      const response = await request(app)
        .post('/reconcile')
        .send(validReconcileData)
        .expect(500);

      // Verify Stellar RPC failure classification
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Stellar RPC failure in reconciliation',
        expect.objectContaining({
          requestId: 'test-request-id',
          userId: 'test-user-id',
          failureClass: classifyStellarRPCFailure(stellarError),
        }),
        LogLevel.WARN
      );
    });

    it('should handle audit log creation failures gracefully', async () => {
      (mockOfferingRepo.findById as jest.Mock).mockResolvedValue({
        id: 'offering-123',
        issuer_user_id: 'test-user-id',
      });

      (mockReconciliationService.reconcile as jest.Mock).mockResolvedValue({
        offeringId: 'offering-123',
        periodStart: new Date('2024-01-01'),
        periodEnd: new Date('2024-01-31'),
        isBalanced: true,
        discrepancies: [],
        summary: {
          totalRevenueReported: '1000.00',
          totalPayouts: '1000.00',
          discrepancyAmount: '0.00',
          investorCount: 5,
          payoutsProcessed: 5,
          payoutsFailed: 0,
        },
        checkedAt: new Date(),
      });

      // Mock audit log failure
      (mockAuditLogRepo.createAuditLog as jest.Mock).mockRejectedValue(
        new Error('Database connection failed')
      );

      const response = await request(app)
        .post('/reconcile')
        .send(validReconcileData)
        .expect(200);

      // Should still succeed despite audit log failure
      expect(response.body.success).toBe(true);

      // Should log audit log creation error
      expect(mockLogger.error).toHaveBeenCalledWith(
        'Failed to create audit log',
        expect.objectContaining({
          requestId: 'test-request-id',
          userId: 'test-user-id',
          offeringId: 'offering-123',
        }),
        LogLevel.ERROR
      );
    });
  });

  describe('GET /balance-check/:offeringId', () => {
    it('should perform quick balance check with audit logging', async () => {
      (mockOfferingRepo.findById as jest.Mock).mockResolvedValue({
        id: 'offering-123',
        issuer_user_id: 'test-user-id',
      });

      const mockResult = {
        isBalanced: true,
        difference: '0.00',
      };
      (mockReconciliationService.quickBalanceCheck as jest.Mock).mockResolvedValue(mockResult);

      (mockAuditLogRepo.createAuditLog as jest.Mock).mockResolvedValue({
        id: 'audit-log-456',
        user_id: 'test-user-id',
        action: 'BALANCE_CHECK_PERFORMED',
        resource: 'offering:offering-123',
        created_at: new Date(),
      });

      const response = await request(app)
        .get('/balance-check/offering-123')
        .query({
          periodStart: '2024-01-01T00:00:00Z',
          periodEnd: '2024-01-31T23:59:59Z',
        })
        .expect(200);

      expect(response.body).toEqual({
        success: true,
        data: mockResult,
      });

      expect(mockAuditLogRepo.createAuditLog).toHaveBeenCalledWith({
        user_id: 'test-user-id',
        action: 'BALANCE_CHECK_PERFORMED',
        resource: 'offering:offering-123',
        details: JSON.stringify({
          periodStart: '2024-01-01T00:00:00Z',
          periodEnd: '2024-01-31T23:59:59Z',
          isBalanced: true,
          difference: '0.00',
        }),
        ip_address: expect.any(String),
        user_agent: expect.any(String),
      });
    });

    it('should handle missing query parameters', async () => {
      const response = await request(app)
        .get('/balance-check/offering-123')
        .expect(400);

      expect(response.body.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('POST /verify-distribution/:runId', () => {
    it('should verify distribution with admin authorization and audit logging', async () => {
      // Mock admin user
      const adminAuth = (req: any, res: any, next: any) => {
        req.user = {
          id: 'admin-user-id',
          role: 'admin',
          sessionToken: 'admin-token',
        };
        req.requestId = 'admin-request-id';
        next();
      };

      const adminApp = createReconciliationRouter({
        db: mockDb,
        auditLogRepo: mockAuditLogRepo,
        logger: mockLogger,
        requireAuth: adminAuth,
      });

      const mockResult = {
        isValid: true,
        errors: [],
      };
      (mockReconciliationService.verifyDistributionRun as jest.Mock).mockResolvedValue(mockResult);

      (mockAuditLogRepo.createAuditLog as jest.Mock).mockResolvedValue({
        id: 'audit-log-789',
        user_id: 'admin-user-id',
        action: 'DISTRIBUTION_VERIFIED',
        resource: 'distribution_run:run-123',
        created_at: new Date(),
      });

      const response = await request(adminApp)
        .post('/verify-distribution/run-123')
        .expect(200);

      expect(response.body).toEqual({
        success: true,
        data: mockResult,
      });

      expect(mockAuditLogRepo.createAuditLog).toHaveBeenCalledWith({
        user_id: 'admin-user-id',
        action: 'DISTRIBUTION_VERIFIED',
        resource: 'distribution_run:run-123',
        details: JSON.stringify({
          runId: 'run-123',
          isValid: true,
          errorsFound: 0,
        }),
        ip_address: expect.any(String),
        user_agent: expect.any(String),
      });
    });

    it('should reject non-admin users', async () => {
      const response = await request(app)
        .post('/verify-distribution/run-123')
        .expect(403);

      expect(response.body.code).toBe('FORBIDDEN');
      expect(response.body.message).toBe('Admin role required to verify distribution runs');
    });
  });

  describe('POST /validate-report', () => {
    it('should validate revenue report with audit logging', async () => {
      (mockOfferingRepo.findById as jest.Mock).mockResolvedValue({
        id: 'offering-123',
        issuer_user_id: 'test-user-id',
      });

      const mockResult = {
        isValid: true,
        errors: [],
      };
      (mockReconciliationService.validateRevenueReport as jest.Mock).mockResolvedValue(mockResult);

      (mockAuditLogRepo.createAuditLog as jest.Mock).mockResolvedValue({
        id: 'audit-log-101',
        user_id: 'test-user-id',
        action: 'REVENUE_REPORT_VALIDATED',
        resource: 'offering:offering-123',
        created_at: new Date(),
      });

      const validReportData = {
        offeringId: 'offering-123',
        amount: '1000.00',
        periodStart: '2024-01-01T00:00:00Z',
        periodEnd: '2024-01-31T23:59:59Z',
      };

      const response = await request(app)
        .post('/validate-report')
        .send(validReportData)
        .expect(200);

      expect(response.body).toEqual({
        success: true,
        data: mockResult,
      });

      expect(mockAuditLogRepo.createAuditLog).toHaveBeenCalledWith({
        user_id: 'test-user-id',
        action: 'REVENUE_REPORT_VALIDATED',
        resource: 'offering:offering-123',
        details: JSON.stringify({
          offeringId: 'offering-123',
          amount: '1000.00',
          periodStart: '2024-01-01T00:00:00Z',
          periodEnd: '2024-01-31T23:59:59Z',
          isValid: true,
          errorsFound: 0,
        }),
        ip_address: expect.any(String),
        user_agent: expect.any(String),
      });
    });

    it('should handle invalid amount values', async () => {
      const invalidData = {
        offeringId: 'offering-123',
        amount: '-100.00', // Negative amount
        periodStart: '2024-01-01T00:00:00Z',
        periodEnd: '2024-01-31T23:59:59Z',
      };

      const response = await request(app)
        .post('/validate-report')
        .send(invalidData)
        .expect(400);

      expect(response.body.code).toBe('VALIDATION_ERROR');
      expect(response.body.message).toBe('amount must be a non-negative number');
    });
  });

  describe('Stellar RPC Failure Classification', () => {
    it('should classify timeout errors correctly', async () => {
      (mockOfferingRepo.findById as jest.Mock).mockResolvedValue({
        id: 'offering-123',
        issuer_user_id: 'test-user-id',
      });

      const timeoutError = new Error('Request timeout');
      timeoutError.name = 'AbortError';
      (mockReconciliationService.reconcile as jest.Mock).mockRejectedValue(timeoutError);

      await request(app)
        .post('/reconcile')
        .send({
          offeringId: 'offering-123',
          periodStart: '2024-01-01T00:00:00Z',
          periodEnd: '2024-01-31T23:59:59Z',
        })
        .expect(500);

      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Stellar RPC failure in reconciliation',
        expect.objectContaining({
          failureClass: StellarRPCFailureClass.TIMEOUT,
        }),
        LogLevel.WARN
      );
    });

    it('should classify rate limit errors correctly', async () => {
      (mockOfferingRepo.findById as jest.Mock).mockResolvedValue({
        id: 'offering-123',
        issuer_user_id: 'test-user-id',
      });

      const rateLimitError = { status: 429 };
      (mockReconciliationService.reconcile as jest.Mock).mockRejectedValue(rateLimitError);

      await request(app)
        .post('/reconcile')
        .send({
          offeringId: 'offering-123',
          periodStart: '2024-01-01T00:00:00Z',
          periodEnd: '2024-01-31T23:59:59Z',
        })
        .expect(500);

      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Stellar RPC failure in reconciliation',
        expect.objectContaining({
          failureClass: StellarRPCFailureClass.RATE_LIMIT,
        }),
        LogLevel.WARN
      );
    });
  });

  describe('Error Handling Edge Cases', () => {
    it('should handle missing repository gracefully', async () => {
      const appWithoutRepo = createReconciliationRouter({
        db: mockDb,
        // No offeringRepo - should skip authorization checks
        logger: mockLogger,
        requireAuth: mockRequireAuth,
      });

      const mockResult = {
        offeringId: 'offering-123',
        periodStart: new Date('2024-01-01'),
        periodEnd: new Date('2024-01-31'),
        isBalanced: true,
        discrepancies: [],
        summary: {
          totalRevenueReported: '1000.00',
          totalPayouts: '1000.00',
          discrepancyAmount: '0.00',
          investorCount: 5,
          payoutsProcessed: 5,
          payoutsFailed: 0,
        },
        checkedAt: new Date(),
      };
      (mockReconciliationService.reconcile as jest.Mock).mockResolvedValue(mockResult);

      const response = await request(appWithoutRepo)
        .post('/reconcile')
        .send({
          offeringId: 'offering-123',
          periodStart: '2024-01-01T00:00:00Z',
          periodEnd: '2024-01-31T23:59:59Z',
        })
        .expect(200);

      expect(response.body.success).toBe(true);
    });

    it('should handle missing audit log repository gracefully', async () => {
      const appWithoutAudit = createReconciliationRouter({
        db: mockDb,
        offeringRepo: mockOfferingRepo,
        // No auditLogRepo - should skip audit logging
        logger: mockLogger,
        requireAuth: mockRequireAuth,
      });

      (mockOfferingRepo.findById as jest.Mock).mockResolvedValue({
        id: 'offering-123',
        issuer_user_id: 'test-user-id',
      });

      const mockResult = {
        offeringId: 'offering-123',
        periodStart: new Date('2024-01-01'),
        periodEnd: new Date('2024-01-31'),
        isBalanced: true,
        discrepancies: [],
        summary: {
          totalRevenueReported: '1000.00',
          totalPayouts: '1000.00',
          discrepancyAmount: '0.00',
          investorCount: 5,
          payoutsProcessed: 5,
          payoutsFailed: 0,
        },
        checkedAt: new Date(),
      };
      (mockReconciliationService.reconcile as jest.Mock).mockResolvedValue(mockResult);

      const response = await request(appWithoutAudit)
        .post('/reconcile')
        .send({
          offeringId: 'offering-123',
          periodStart: '2024-01-01T00:00:00Z',
          periodEnd: '2024-01-31T23:59:59Z',
        })
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(mockAuditLogRepo.createAuditLog).not.toHaveBeenCalled();
    });
  });
});
