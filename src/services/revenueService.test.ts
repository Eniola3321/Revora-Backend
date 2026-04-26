import { RevenueService, RevenueReportInput } from './revenueService';
import { AppError, ErrorCode } from '../lib/errors';
import { Decimal } from '../lib/decimal';
import { Logger } from '../lib/logger';

// Mock Logger
const mockLogger: Logger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  trace: jest.fn(),
  critical: jest.fn(),
  alert: jest.fn(),
  emergency: jest.fn(),
  child: jest.fn(() => mockLogger),
};

// Mock StellarService
const mockStellarService = {
  submitRevenueToSoroban: jest.fn(),
};

// Mock RevenueRepository
const mockRevenueRepository = {
  saveRevenueReport: jest.fn(),
};

describe('RevenueService', () => {
  let revenueService: RevenueService;

  beforeEach(() => {
    jest.clearAllMocks();
    revenueService = new RevenueService(mockStellarService, mockRevenueRepository, mockLogger);
  });

  describe('ingestRevenueReport', () => {
    const validReport: RevenueReportInput = {
      offeringId: 'offering-123',
      amount: '100.50',
      periodStart: '2023-01-01T00:00:00Z',
      periodEnd: '2023-01-31T23:59:59Z',
    };

    it('should successfully ingest a valid revenue report', async () => {
      mockStellarService.submitRevenueToSoroban.mockResolvedValue('stellar-tx-123');
      mockRevenueRepository.saveRevenueReport.mockResolvedValue(undefined);

      const result = await revenueService.ingestRevenueReport(validReport);

      expect(result).toBe('stellar-tx-123');
      expect(mockLogger.info).toHaveBeenCalledWith('Revenue submitted to Soroban', expect.any(Object));
      expect(mockLogger.info).toHaveBeenCalledWith('Revenue report saved', expect.any(Object));
      expect(mockStellarService.submitRevenueToSoroban).toHaveBeenCalledWith(
        validReport.offeringId,
        new Decimal(validReport.amount).toSorobanI128(7), // Assuming scale 7
        new Date(validReport.periodStart),
        new Date(validReport.periodEnd)
      );
      expect(mockRevenueRepository.saveRevenueReport).toHaveBeenCalledWith(
        expect.objectContaining({
          ...validReport,
          amountI128: new Decimal(validReport.amount).toSorobanI128(7),
        })
      );
    });

    it('should throw AppError for invalid amount format', async () => {
      const invalidAmountReport = { ...validReport, amount: 'invalid-amount' };
      await expect(revenueService.ingestRevenueReport(invalidAmountReport)).rejects.toThrow(AppError);
      await expect(revenueService.ingestRevenueReport(invalidAmountReport)).rejects.toHaveProperty('code', ErrorCode.VALIDATION_ERROR);
      expect(mockLogger.warn).toHaveBeenCalledWith('Invalid revenue amount format', expect.any(Object));
    });

    it('should throw AppError for zero amount', async () => {
      const zeroAmountReport = { ...validReport, amount: '0.00' };
      await expect(revenueService.ingestRevenueReport(zeroAmountReport)).rejects.toThrow(AppError);
      await expect(revenueService.ingestRevenueReport(zeroAmountReport)).rejects.toHaveProperty('code', ErrorCode.VALIDATION_ERROR);
      expect(mockLogger.warn).toHaveBeenCalledWith('Invalid revenue amount format', expect.any(Object)); // Decimal constructor will pass, but then isZero() check fails
    });

    it('should throw AppError for amount exceeding Soroban i128 limits', async () => {
      const hugeAmountReport = { ...validReport, amount: '170141183460469231731687303715884105728' }; // I128_MAX + 1
      await expect(revenueService.ingestRevenueReport(hugeAmountReport)).rejects.toThrow(AppError);
      await expect(revenueService.ingestRevenueReport(hugeAmountReport)).rejects.toHaveProperty('code', ErrorCode.VALIDATION_ERROR);
      expect(mockLogger.error).toHaveBeenCalledWith('Failed to convert decimal amount to Soroban i128', expect.any(Object));
    });

    it('should throw AppError for invalid periodStart date', async () => {
      const invalidDateReport = { ...validReport, periodStart: 'not-a-date' };
      await expect(revenueService.ingestRevenueReport(invalidDateReport)).rejects.toThrow(AppError);
      await expect(revenueService.ingestRevenueReport(invalidDateReport)).rejects.toHaveProperty('code', ErrorCode.VALIDATION_ERROR);
    });

    it('should throw AppError for invalid periodEnd date', async () => {
      const invalidDateReport = { ...validReport, periodEnd: 'not-a-date' };
      await expect(revenueService.ingestRevenueReport(invalidDateReport)).rejects.toThrow(AppError);
      await expect(revenueService.ingestRevenueReport(invalidDateReport)).rejects.toHaveProperty('code', ErrorCode.VALIDATION_ERROR);
    });

    it('should throw AppError if periodEnd is not after periodStart', async () => {
      const invertedDatesReport = { ...validReport, periodStart: '2023-01-31T23:59:59Z', periodEnd: '2023-01-01T00:00:00Z' };
      await expect(revenueService.ingestRevenueReport(invertedDatesReport)).rejects.toThrow(AppError);
      await expect(revenueService.ingestRevenueReport(invertedDatesReport)).rejects.toHaveProperty('code', ErrorCode.VALIDATION_ERROR);
    });

    it('should classify and throw AppError for Stellar RPC 400 (Bad Request)', async () => {
      const stellarError = { response: { status: 400, data: { extras: { result_codes: { transaction: 'tx_bad_auth' } } } } };
      mockStellarService.submitRevenueToSoroban.mockRejectedValue(stellarError);

      await expect(revenueService.ingestRevenueReport(validReport)).rejects.toThrow(AppError);
      await expect(revenueService.ingestRevenueReport(validReport)).rejects.toHaveProperty('code', ErrorCode.BAD_REQUEST);
      expect(mockLogger.error).toHaveBeenCalledWith('Stellar RPC submission failed', expect.any(Object));
      expect(mockLogger.warn).toHaveBeenCalledWith('Stellar RPC Bad Request', expect.any(Object));
    });

    it('should classify and throw AppError for Stellar RPC 404 (Not Found)', async () => {
      const stellarError = { response: { status: 404, data: { extras: { result_codes: { transaction: 'tx_no_source_account' } } } } };
      mockStellarService.submitRevenueToSoroban.mockRejectedValue(stellarError);

      await expect(revenueService.ingestRevenueReport(validReport)).rejects.toThrow(AppError);
      await expect(revenueService.ingestRevenueReport(validReport)).rejects.toHaveProperty('code', ErrorCode.NOT_FOUND);
      expect(mockLogger.error).toHaveBeenCalledWith('Stellar RPC submission failed', expect.any(Object));
      expect(mockLogger.warn).toHaveBeenCalledWith('Stellar RPC Not Found', expect.any(Object));
    });

    it('should classify and throw AppError for Stellar RPC 500 (Internal Server Error)', async () => {
      const stellarError = { response: { status: 500, data: { extras: { result_codes: { transaction: 'tx_internal_error' } } } };
      mockStellarService.submitRevenueToSoroban.mockRejectedValue(stellarError);

      await expect(revenueService.ingestRevenueReport(validReport)).rejects.toThrow(AppError);
      await expect(revenueService.ingestRevenueReport(validReport)).rejects.toHaveProperty('code', ErrorCode.SERVICE_UNAVAILABLE);
      expect(mockLogger.error).toHaveBeenCalledWith('Stellar RPC submission failed', expect.any(Object));
      expect(mockLogger.error).toHaveBeenCalledWith('Stellar RPC Internal Error', expect.any(Object));
    });

    it('should classify and throw generic AppError for unclassified Stellar RPC errors', async () => {
      const unknownError = new Error('Network error');
      mockStellarService.submitRevenueToSoroban.mockRejectedValue(unknownError);

      await expect(revenueService.ingestRevenueReport(validReport)).rejects.toThrow(AppError);
      await expect(revenueService.ingestRevenueReport(validReport)).rejects.toHaveProperty('code', ErrorCode.INTERNAL_ERROR);
      expect(mockLogger.error).toHaveBeenCalledWith('Stellar RPC submission failed', expect.any(Object));
      expect(mockLogger.error).toHaveBeenCalledWith('Unclassified Stellar RPC error', expect.any(Object));
    });

    it('should throw AppError if saving revenue report fails', async () => {
      mockStellarService.submitRevenueToSoroban.mockResolvedValue('stellar-tx-123');
      mockRevenueRepository.saveRevenueReport.mockRejectedValue(new Error('DB connection lost'));

      await expect(revenueService.ingestRevenueReport(validReport)).rejects.toThrow(AppError);
      await expect(revenueService.ingestRevenueReport(validReport)).rejects.toHaveProperty('code', ErrorCode.INTERNAL_ERROR);
      expect(mockLogger.error).toHaveBeenCalledWith('Failed to save revenue report to database', expect.any(Object));
    });
  });
});