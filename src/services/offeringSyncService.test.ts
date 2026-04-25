import { OfferingSyncService, StellarClient, RealStellarClient, SyncResult, StaleCatalogResult, StaleCatalogConfig } from './offeringSyncService';
import { OfferingRepository, Offering } from '../db/repositories/offeringRepository';
import { Logger, globalLogger } from '../lib/logger';
import { Errors } from '../lib/errors';
import { StellarRPCFailureClass } from '../lib/stellarRpcFailure';

const mockOffering: Offering = {
  id: 'offering-1',
  contract_address: 'CONTRACT_ABC',
  status: 'active',
  total_raised: '5000.00',
  created_at: new Date('2024-01-01'),
  updated_at: new Date('2024-01-02'),
};

const mockStaleOffering: Offering = {
  id: 'offering-stale',
  contract_address: 'CONTRACT_STALE',
  status: 'active',
  total_raised: '1000.00',
  created_at: new Date('2024-01-01'),
  updated_at: new Date('2023-12-01'), // Very old
};

const mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  child: jest.fn(() => mockLogger),
} as unknown as Logger;

const mockOfferingRepo = {
  findById: jest.fn(),
  listAll: jest.fn(),
  updateState: jest.fn(),
  findByContractAddress: jest.fn(),
} as unknown as OfferingRepository;

const mockStellarClient: StellarClient = {
  getOfferingState: jest.fn(),
  getAccountInfo: jest.fn(),
  validateContractAddress: jest.fn(),
};

const service = new OfferingSyncService(mockOfferingRepo, mockStellarClient, { logger: mockLogger });

describe('OfferingSyncService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Reset logger mock
    Object.keys(mockLogger).forEach(key => {
      (mockLogger as any)[key].mockClear();
    });
  });

  describe('syncOffering', () => {
    it('returns error if offering not found', async () => {
      (mockOfferingRepo.findById as jest.Mock).mockResolvedValueOnce(null);
      const result = await service.syncOffering('missing-id');
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/not found/);
      expect(result.duration).toBeDefined();
      expect(mockLogger.warn).toHaveBeenCalledWith('Offering not found for sync', { offeringId: 'missing-id' });
    });

    it('does not update if state is unchanged', async () => {
      (mockOfferingRepo.findById as jest.Mock).mockResolvedValueOnce(mockOffering);
      (mockStellarClient.getOfferingState as jest.Mock).mockResolvedValueOnce({
        status: 'active',
        total_raised: '5000.00',
        last_updated_ledger: 12345,
      });
      const result = await service.syncOffering('offering-1');
      expect(result.success).toBe(true);
      expect(result.updated).toBe(false);
      expect(result.duration).toBeDefined();
      expect(mockOfferingRepo.updateState).not.toHaveBeenCalled();
      expect(mockLogger.debug).toHaveBeenCalledWith('Offering state unchanged', {
        offeringId: 'offering-1',
        contractAddress: 'CONTRACT_ABC',
      });
    });

    it('updates DB if state has changed', async () => {
      (mockOfferingRepo.findById as jest.Mock).mockResolvedValueOnce(mockOffering);
      (mockStellarClient.getOfferingState as jest.Mock).mockResolvedValueOnce({
        status: 'closed',
        total_raised: '9000.00',
        last_updated_ledger: 12346,
      });
      (mockOfferingRepo.updateState as jest.Mock).mockResolvedValueOnce({
        ...mockOffering,
        status: 'closed',
        total_raised: '9000.00',
      });
      const result = await service.syncOffering('offering-1');
      expect(result.success).toBe(true);
      expect(result.updated).toBe(true);
      expect(result.duration).toBeDefined();
      expect(mockOfferingRepo.updateState).toHaveBeenCalledWith('offering-1', {
        status: 'closed',
        total_raised: '9000.00',
      });
      expect(mockLogger.info).toHaveBeenCalledWith('Offering updated from chain', {
        offeringId: 'offering-1',
        contractAddress: 'CONTRACT_ABC',
        oldStatus: 'active',
        newStatus: 'closed',
        oldTotalRaised: '5000.00',
        newTotalRaised: '9000.00',
        duration: expect.any(Number),
      });
    });

    it('returns error if stellar client throws', async () => {
      (mockOfferingRepo.findById as jest.Mock).mockResolvedValueOnce(mockOffering);
      (mockStellarClient.getOfferingState as jest.Mock).mockRejectedValueOnce(
        new Error('Network error')
      );
      const result = await service.syncOffering('offering-1');
      expect(result.success).toBe(false);
      expect(result.error).toBe('Network error');
      expect(result.failureClass).toBe(StellarRPCFailureClass.UNKNOWN);
      expect(result.duration).toBeDefined();
      expect(mockLogger.error).toHaveBeenCalledWith('Failed to sync offering', {
        offeringId: 'offering-1',
        error: 'Network error',
        failureClass: StellarRPCFailureClass.UNKNOWN,
      });
    });

    it('returns error if offering has no contract address', async () => {
      const offeringWithoutContract = { ...mockOffering, contract_address: undefined };
      (mockOfferingRepo.findById as jest.Mock).mockResolvedValueOnce(offeringWithoutContract);
      const result = await service.syncOffering('offering-1');
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/contract_address configured/);
      expect(result.duration).toBeDefined();
      expect(mockLogger.warn).toHaveBeenCalledWith('Offering missing contract address', {
        offeringId: 'offering-1',
      });
    });
  });

  describe('syncAll', () => {
    it('syncs all offerings and returns results', async () => {
      (mockOfferingRepo.listAll as jest.Mock).mockResolvedValueOnce([mockOffering]);
      (mockStellarClient.getOfferingState as jest.Mock).mockResolvedValueOnce({
        status: 'closed',
        total_raised: '9000.00',
        last_updated_ledger: 12346,
      });
      (mockOfferingRepo.updateState as jest.Mock).mockResolvedValueOnce({
        ...mockOffering,
        status: 'closed',
      });
      const results = await service.syncAll();
      expect(results).toHaveLength(1);
      expect(results[0].success).toBe(true);
      expect(results[0].updated).toBe(true);
      expect(results[0].duration).toBeDefined();
      expect(mockLogger.info).toHaveBeenCalledWith('Starting full catalog sync');
      expect(mockLogger.info).toHaveBeenCalledWith('Full catalog sync completed', {
        total: 1,
        successful: 1,
        failed: 0,
        updated: 1,
        duration: expect.any(Number),
      });
    });

    it('returns failure result if one offering fails', async () => {
      (mockOfferingRepo.listAll as jest.Mock).mockResolvedValueOnce([mockOffering]);
      (mockStellarClient.getOfferingState as jest.Mock).mockRejectedValueOnce(
        new Error('Timeout')
      );
      const results = await service.syncAll();
      expect(results[0].success).toBe(false);
      expect(results[0].error).toBe('Timeout');
      expect(results[0].failureClass).toBe(StellarRPCFailureClass.UNKNOWN);
      expect(results[0].duration).toBe(0);
    });

    it('handles empty offerings list', async () => {
      (mockOfferingRepo.listAll as jest.Mock).mockResolvedValueOnce([]);
      const results = await service.syncAll();
      expect(results).toHaveLength(0);
      expect(mockLogger.info).toHaveBeenCalledWith('Found offerings for sync', { count: 0 });
    });
  });

  describe('recoverStaleCatalog', () => {
    const mockStaleConfig: Partial<StaleCatalogConfig> = {
      staleThresholdHours: 24,
      batchSize: 10,
      autoUpdate: true,
    };

    it('recovers stale offerings successfully', async () => {
      const serviceWithConfig = new OfferingSyncService(mockOfferingRepo, mockStellarClient, {
        logger: mockLogger,
        staleConfig: mockStaleConfig,
      });

      (mockOfferingRepo.listAll as jest.Mock).mockResolvedValueOnce([mockStaleOffering]);
      (mockStellarClient.getOfferingState as jest.Mock).mockResolvedValueOnce({
        status: 'completed',
        total_raised: '2000.00',
        last_updated_ledger: 12347,
      });
      (mockOfferingRepo.updateState as jest.Mock).mockResolvedValueOnce({
        ...mockStaleOffering,
        status: 'completed',
        total_raised: '2000.00',
      });

      const result = await serviceWithConfig.recoverStaleCatalog();

      expect(result.totalProcessed).toBe(1);
      expect(result.staleFound).toBe(1);
      expect(result.updated).toBe(1);
      expect(result.failed).toBe(0);
      expect(result.duration).toBeDefined();
      expect(mockLogger.info).toHaveBeenCalledWith('Starting stale catalog recovery', {
        staleThresholdHours: 24,
        batchSize: 10,
        autoUpdate: true,
      });
      expect(mockLogger.info).toHaveBeenCalledWith('Recovered stale offering', {
        offeringId: 'offering-stale',
        contractAddress: 'CONTRACT_STALE',
      });
    });

    it('handles stale catalog recovery failures', async () => {
      const serviceWithConfig = new OfferingSyncService(mockOfferingRepo, mockStellarClient, {
        logger: mockLogger,
        staleConfig: mockStaleConfig,
      });

      (mockOfferingRepo.listAll as jest.Mock).mockResolvedValueOnce([mockStaleOffering]);
      (mockStellarClient.getOfferingState as jest.Mock).mockRejectedValueOnce(
        new Error('RPC failure')
      );

      const result = await serviceWithConfig.recoverStaleCatalog();

      expect(result.totalProcessed).toBe(1);
      expect(result.staleFound).toBe(1);
      expect(result.updated).toBe(0);
      expect(result.failed).toBe(1);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].offeringId).toBe('offering-stale');
      expect(result.errors[0].error).toBe('RPC failure');
      expect(result.errors[0].failureClass).toBe(StellarRPCFailureClass.UNKNOWN);
    });

    it('handles no stale offerings', async () => {
      const serviceWithConfig = new OfferingSyncService(mockOfferingRepo, mockStellarClient, {
        logger: mockLogger,
        staleConfig: mockStaleConfig,
      });

      (mockOfferingRepo.listAll as jest.Mock).mockResolvedValueOnce([]);

      const result = await serviceWithConfig.recoverStaleCatalog();

      expect(result.totalProcessed).toBe(0);
      expect(result.staleFound).toBe(0);
      expect(result.updated).toBe(0);
      expect(result.failed).toBe(0);
      expect(result.duration).toBeDefined();
    });
  });

  describe('getSyncStats', () => {
    it('returns sync statistics', async () => {
      const serviceWithConfig = new OfferingSyncService(mockOfferingRepo, mockStellarClient, {
        logger: mockLogger,
        staleConfig: { staleThresholdHours: 24 },
      });

      const offerings = [
        mockOffering,
        mockStaleOffering,
        { ...mockOffering, id: 'offering-3', contract_address: undefined },
      ];
      (mockOfferingRepo.listAll as jest.Mock).mockResolvedValueOnce(offerings);

      const stats = await serviceWithConfig.getSyncStats();

      expect(stats.totalOfferings).toBe(3);
      expect(stats.withContractAddress).toBe(2);
      expect(stats.recentlyUpdated).toBe(2); // mockOffering and offering-3 have recent dates
      expect(stats.staleThreshold).toBeInstanceOf(Date);
      expect(mockLogger.debug).toHaveBeenCalledWith('Sync statistics retrieved', stats);
    });
  });

  describe('RealStellarClient', () => {
    let realClient: RealStellarClient;

    beforeEach(() => {
      realClient = new RealStellarClient({ logger: mockLogger });
    });

    it('validates contract addresses correctly', () => {
      expect(realClient.validateContractAddress('abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890')).toBe(true);
      expect(realClient.validateContractAddress('invalid')).toBe(false);
      expect(realClient.validateContractAddress('ABC123')).toBe(false);
    });

    it('throws error for invalid contract address format', async () => {
      await expect(realClient.getOfferingState('invalid')).rejects.toThrow('Invalid contract address format');
    });

    it('fetches offering state successfully', async () => {
      const validAddress = 'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890';
      const state = await realClient.getOfferingState(validAddress);

      expect(state.status).toBe('active');
      expect(state.total_raised).toBe('1000.0000000');
      expect(state.last_updated_ledger).toBe(12345);
      expect(mockLogger.info).toHaveBeenCalledWith('Fetching offering state from chain', {
        contractAddress: validAddress,
      });
      expect(mockLogger.debug).toHaveBeenCalledWith('Successfully fetched offering state', {
        contractAddress: validAddress,
        status: 'active',
        total_raised: '1000.0000000',
      });
    });

    it('maps contract statuses correctly', () => {
      const client = realClient as any;
      expect(client.mapContractStatusToOfferingStatus('draft')).toBe('draft');
      expect(client.mapContractStatusToOfferingStatus('open')).toBe('active');
      expect(client.mapContractStatusToOfferingStatus('active')).toBe('active');
      expect(client.mapContractStatusToOfferingStatus('closed')).toBe('closed');
      expect(client.mapContractStatusToOfferingStatus('completed')).toBe('completed');
      expect(client.mapContractStatusToOfferingStatus('cancelled')).toBe('closed');
      expect(client.mapContractStatusToOfferingStatus('unknown')).toBe('draft');
    });
  });
});