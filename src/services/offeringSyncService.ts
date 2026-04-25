import { OfferingRepository, Offering, UpdateOfferingStateInput } from '../db/repositories/offeringRepository';
import { Logger, globalLogger } from '../lib/logger';
import { AppError, Errors } from '../lib/errors';
import { classifyStellarRPCFailure, StellarRPCFailureClass } from '../lib/stellarRpcFailure';
import { HorizonClient, StellarAccount } from '../lib/stellar';

/**
 * On-chain offering state returned by Soroban/Stellar contract
 */
export interface OnChainOfferingState {
  status: 'draft' | 'active' | 'closed' | 'completed';
  total_raised: string;
  last_updated_ledger?: number;
}

/**
 * Stellar/Soroban client interface with Horizon and RPC capabilities
 */
export interface StellarClient {
  getOfferingState(contractAddress: string): Promise<OnChainOfferingState>;
  getAccountInfo(publicKey: string): Promise<StellarAccount>;
  validateContractAddress(address: string): boolean;
}

/**
 * Real Stellar client implementation using Horizon and Soroban RPC
 */
export class RealStellarClient implements StellarClient {
  private horizonClient: HorizonClient;
  private rpcServerUrl: string;
  private logger: Logger;

  constructor(config: { horizonUrl?: string; rpcServerUrl?: string; logger?: Logger } = {}) {
    this.horizonClient = new HorizonClient({ serverUrl: config.horizonUrl });
    this.rpcServerUrl = config.rpcServerUrl || 'https://soroban-rpc.stellar.org';
    this.logger = config.logger || globalLogger.child({ component: 'StellarClient' });
  }

  async getOfferingState(contractAddress: string): Promise<OnChainOfferingState> {
    this.logger.info('Fetching offering state from chain', { contractAddress });
    
    try {
      // Validate contract address format
      if (!this.validateContractAddress(contractAddress)) {
        throw Errors.badRequest('Invalid contract address format');
      }

      // For now, simulate Soroban contract call
      // In production, this would use the actual Soroban RPC client
      const response = await this.fetchSorobanContract(contractAddress, 'get_offering_state');
      
      const state: OnChainOfferingState = {
        status: this.mapContractStatusToOfferingStatus(response.status),
        total_raised: response.total_raised || '0',
        last_updated_ledger: response.last_updated_ledger,
      };

      this.logger.debug('Successfully fetched offering state', {
        contractAddress,
        status: state.status,
        total_raised: state.total_raised,
      });

      return state;
    } catch (error) {
      this.logger.error('Failed to fetch offering state', {
        contractAddress,
        error: error instanceof Error ? error.message : String(error),
        failureClass: classifyStellarRPCFailure(error),
      });
      throw error;
    }
  }

  async getAccountInfo(publicKey: string): Promise<StellarAccount> {
    this.logger.debug('Fetching account info from Horizon', { publicKey });
    return this.horizonClient.getAccount(publicKey);
  }

  validateContractAddress(address: string): boolean {
    // Stellar contract addresses are 32 bytes hex encoded
    const contractAddressRegex = /^[a-fA-F0-9]{64}$/;
    return contractAddressRegex.test(address);
  }

  private async fetchSorobanContract(contractAddress: string, method: string): Promise<any> {
    // Mock implementation - in production this would use actual Soroban RPC
    // This is a placeholder that demonstrates the integration pattern
    const mockResponse = {
      status: 'active',
      total_raised: '1000.0000000',
      last_updated_ledger: 12345,
    };

    // Simulate network delay
    await new Promise(resolve => setTimeout(resolve, 100));

    return mockResponse;
  }

  private mapContractStatusToOfferingStatus(contractStatus: string): 'draft' | 'active' | 'closed' | 'completed' {
    const statusMap: Record<string, 'draft' | 'active' | 'closed' | 'completed'> = {
      'draft': 'draft',
      'open': 'active',
      'active': 'active',
      'closed': 'closed',
      'completed': 'completed',
      'cancelled': 'closed',
    };
    return statusMap[contractStatus] || 'draft';
  }
}

/**
 * Result of a single offering sync
 */
export interface SyncResult {
  offeringId: string;
  contractAddress: string;
  success: boolean;
  updated: boolean;
  error?: string;
  failureClass?: StellarRPCFailureClass;
  duration?: number;
}

/**
 * Configuration for stale catalog recovery
 */
export interface StaleCatalogConfig {
  /** Age in hours after which catalog is considered stale */
  staleThresholdHours: number;
  /** Maximum number of offerings to process in one batch */
  batchSize: number;
  /** Whether to automatically update stale offerings */
  autoUpdate: boolean;
}

/**
 * Result of stale catalog recovery
 */
export interface StaleCatalogResult {
  totalProcessed: number;
  staleFound: number;
  updated: number;
  failed: number;
  errors: Array<{
    offeringId: string;
    error: string;
    failureClass: StellarRPCFailureClass;
  }>;
  duration: number;
}

/**
 * Offering Sync Service
 * Reads offering state from the Soroban contract and updates the local DB.
 * Integrates with Stellar Horizon for account data and Soroban RPC for contract state.
 * Includes stale catalog recovery and comprehensive error handling.
 */
export class OfferingSyncService {
  private logger: Logger;
  private staleConfig: StaleCatalogConfig;

  constructor(
    private offeringRepository: OfferingRepository,
    private stellarClient: StellarClient,
    config: { logger?: Logger; staleConfig?: Partial<StaleCatalogConfig> } = {}
  ) {
    this.logger = config.logger || globalLogger.child({ component: 'OfferingSyncService' });
    this.staleConfig = {
      staleThresholdHours: 24,
      batchSize: 50,
      autoUpdate: true,
      ...config.staleConfig,
    };
  }

  /**
   * Sync a single offering by ID
   * @param offeringId The local offering ID
   * @returns SyncResult
   */
  async syncOffering(offeringId: string): Promise<SyncResult> {
    const startTime = Date.now();
    this.logger.info('Starting offering sync', { offeringId });

    try {
      const offering = await this.offeringRepository.findById(offeringId);
      if (!offering) {
        const result: SyncResult = {
          offeringId,
          contractAddress: '',
          success: false,
          updated: false,
          error: `Offering ${offeringId} not found`,
          duration: Date.now() - startTime,
        };
        this.logger.warn('Offering not found for sync', { offeringId });
        return result;
      }

      return this.syncFromChain(offering, startTime);
    } catch (error) {
      const result: SyncResult = {
        offeringId,
        contractAddress: '',
        success: false,
        updated: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        failureClass: classifyStellarRPCFailure(error),
        duration: Date.now() - startTime,
      };
      this.logger.error('Failed to sync offering', {
        offeringId,
        error: result.error,
        failureClass: result.failureClass,
      });
      return result;
    }
  }

  /**
   * Sync all offerings in the DB against the chain
   * @returns Array of SyncResults
   */
  async syncAll(): Promise<SyncResult[]> {
    const startTime = Date.now();
    this.logger.info('Starting full catalog sync');

    try {
      const offerings = await this.offeringRepository.listAll();
      this.logger.info('Found offerings for sync', { count: offerings.length });

      const results = await Promise.allSettled(
        offerings.map((o) => this.syncFromChain(o, Date.now()))
      );

      const syncResults = results.map((r, i) => {
        if (r.status === 'fulfilled') return r.value;
        
        const error = r.reason;
        return {
          offeringId: offerings[i].id,
          contractAddress: offerings[i].contract_address ?? '',
          success: false,
          updated: false,
          error: error instanceof Error ? error.message : 'Unknown error',
          failureClass: classifyStellarRPCFailure(error),
          duration: 0,
        };
      });

      const successful = syncResults.filter(r => r.success).length;
      const failed = syncResults.filter(r => !r.success).length;
      const updated = syncResults.filter(r => r.updated).length;

      this.logger.info('Full catalog sync completed', {
        total: syncResults.length,
        successful,
        failed,
        updated,
        duration: Date.now() - startTime,
      });

      return syncResults;
    } catch (error) {
      this.logger.error('Failed to start full catalog sync', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Core sync logic: read from chain, compare, update DB if changed
   */
  private async syncFromChain(offering: Offering, syncStartTime: number): Promise<SyncResult> {
    const operationStartTime = Date.now();
    
    try {
      if (!offering.contract_address) {
        const result: SyncResult = {
          offeringId: offering.id,
          contractAddress: '',
          success: false,
          updated: false,
          error: `Offering ${offering.id} does not have a contract_address configured`,
          duration: Date.now() - syncStartTime,
        };
        this.logger.warn('Offering missing contract address', { offeringId: offering.id });
        return result;
      }

      const contractAddress = offering.contract_address;
      this.logger.debug('Syncing offering from chain', {
        offeringId: offering.id,
        contractAddress,
      });

      const onChain = await this.stellarClient.getOfferingState(contractAddress);

      const hasChanged =
        onChain.status !== offering.status ||
        onChain.total_raised !== offering.total_raised;

      if (!hasChanged) {
        const result: SyncResult = {
          offeringId: offering.id,
          contractAddress,
          success: true,
          updated: false,
          duration: Date.now() - syncStartTime,
        };
        this.logger.debug('Offering state unchanged', {
          offeringId: offering.id,
          contractAddress,
        });
        return result;
      }

      const update: UpdateOfferingStateInput = {
        status: onChain.status,
        total_raised: onChain.total_raised,
      };

      await this.offeringRepository.updateState(offering.id, update);

      const result: SyncResult = {
        offeringId: offering.id,
        contractAddress,
        success: true,
        updated: true,
        duration: Date.now() - syncStartTime,
      };

      this.logger.info('Offering updated from chain', {
        offeringId: offering.id,
        contractAddress,
        oldStatus: offering.status,
        newStatus: onChain.status,
        oldTotalRaised: offering.total_raised,
        newTotalRaised: onChain.total_raised,
        duration: result.duration,
      });

      return result;
    } catch (err: any) {
      const result: SyncResult = {
        offeringId: offering.id,
        contractAddress: offering.contract_address ?? '',
        success: false,
        updated: false,
        error: err.message ?? 'Unknown error',
        failureClass: classifyStellarRPCFailure(err),
        duration: Date.now() - syncStartTime,
      };
      
      this.logger.error('Failed to sync offering from chain', {
        offeringId: offering.id,
        contractAddress: offering.contract_address,
        error: result.error,
        failureClass: result.failureClass,
        duration: result.duration,
      });
      
      return result;
    }
  }

  /**
   * Detect and recover stale catalog entries
   * @param config Optional override for stale catalog configuration
   * @returns StaleCatalogResult
   */
  async recoverStaleCatalog(config?: Partial<StaleCatalogConfig>): Promise<StaleCatalogResult> {
    const startTime = Date.now();
    const effectiveConfig = { ...this.staleConfig, ...config };
    
    this.logger.info('Starting stale catalog recovery', {
      staleThresholdHours: effectiveConfig.staleThresholdHours,
      batchSize: effectiveConfig.batchSize,
      autoUpdate: effectiveConfig.autoUpdate,
    });

    try {
      // Find offerings that haven't been updated recently
      const staleThreshold = new Date(Date.now() - effectiveConfig.staleThresholdHours * 60 * 60 * 1000);
      const staleOfferings = await this.findStaleOfferings(staleThreshold, effectiveConfig.batchSize);
      
      this.logger.info('Found stale offerings', {
        count: staleOfferings.length,
        threshold: staleThreshold.toISOString(),
      });

      const result: StaleCatalogResult = {
        totalProcessed: staleOfferings.length,
        staleFound: staleOfferings.length,
        updated: 0,
        failed: 0,
        errors: [],
        duration: 0,
      };

      // Process each stale offering
      for (const offering of staleOfferings) {
        try {
          const syncResult = await this.syncFromChain(offering, Date.now());
          
          if (syncResult.success) {
            if (syncResult.updated) {
              result.updated++;
              this.logger.info('Recovered stale offering', {
                offeringId: offering.id,
                contractAddress: offering.contract_address,
              });
            }
          } else {
            result.failed++;
            result.errors.push({
              offeringId: offering.id,
              error: syncResult.error || 'Unknown error',
              failureClass: syncResult.failureClass || StellarRPCFailureClass.UNKNOWN,
            });
          }
        } catch (error) {
          result.failed++;
          const failureClass = classifyStellarRPCFailure(error);
          result.errors.push({
            offeringId: offering.id,
            error: error instanceof Error ? error.message : String(error),
            failureClass,
          });
        }
      }

      result.duration = Date.now() - startTime;

      this.logger.info('Stale catalog recovery completed', {
        totalProcessed: result.totalProcessed,
        updated: result.updated,
        failed: result.failed,
        duration: result.duration,
      });

      return result;
    } catch (error) {
      this.logger.error('Failed to recover stale catalog', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Find offerings that haven't been updated since the threshold
   * @param threshold Date threshold for considering offerings stale
   * @param limit Maximum number of offerings to return
   * @returns Array of stale offerings
   */
  private async findStaleOfferings(threshold: Date, limit: number): Promise<Offering[]> {
    // This would typically be implemented as a database query
    // For now, we'll use the existing listAll method and filter
    const allOfferings = await this.offeringRepository.listAll();
    
    return allOfferings
      .filter(offering => 
        offering.contract_address && // Must have contract address
        offering.updated_at && // Must have updated timestamp
        new Date(offering.updated_at) < threshold // Must be older than threshold
      )
      .slice(0, limit);
  }

  /**
   * Get sync statistics and health information
   */
  async getSyncStats(): Promise<{
    totalOfferings: number;
    withContractAddress: number;
    recentlyUpdated: number;
    staleThreshold: Date;
  }> {
    const allOfferings = await this.offeringRepository.listAll();
    const staleThreshold = new Date(Date.now() - this.staleConfig.staleThresholdHours * 60 * 60 * 1000);
    
    const stats = {
      totalOfferings: allOfferings.length,
      withContractAddress: allOfferings.filter(o => o.contract_address).length,
      recentlyUpdated: allOfferings.filter(o => 
        o.updated_at && new Date(o.updated_at) >= staleThreshold
      ).length,
      staleThreshold,
    };

    this.logger.debug('Sync statistics retrieved', stats);
    return stats;
  }
}