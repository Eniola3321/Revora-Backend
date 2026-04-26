import {
  OfferingRepository,
  Offering,
  UpdateOfferingStateInput,
} from '../db/repositories/offeringRepository';
import {
  canTransition,
  normalizeOfferingStatus,
} from '../lib/offeringStatusGuard';
import {
  classifyStellarRPCFailure,
  StellarRPCFailureClass,
} from '../lib/stellarRpcFailure';
import { Logger, globalLogger } from '../lib/logger';

export interface OnChainOfferingState {
  status: 'draft' | 'active' | 'closed' | 'completed';
  total_raised: string;
}

export interface StellarClient {
  getOfferingState(contractAddress: string): Promise<OnChainOfferingState>;
}

export interface SyncResult {
  offeringId: string;
  contractAddress: string;
  success: boolean;
  updated: boolean;
  offering?: Offering;
  error?: string;
  failureClass?: StellarRPCFailureClass;
}

export class OfferingSyncService {
  private readonly logger: Logger;

  constructor(
    private readonly offeringRepository: OfferingRepository,
    private readonly stellarClient: StellarClient,
    logger: Logger = globalLogger,
  ) {
    this.logger = logger.child({ module: 'OfferingSyncService' });
  }

  async syncOffering(offeringId: string): Promise<SyncResult> {
    const offering = await this.offeringRepository.findById(offeringId);
    if (!offering) {
      return {
        offeringId,
        contractAddress: '',
        success: false,
        updated: false,
        error: 'Offering not found',
      };
    }

    return this.syncOfferingRecord(offering);
  }

  async syncOfferingRecord(offering: Offering): Promise<SyncResult> {
    try {
      if (!offering.contract_address) {
        this.logger.warn('Skipping offering sync without contract address', {
          offeringId: offering.id,
        });

        return {
          offeringId: offering.id,
          contractAddress: '',
          success: false,
          updated: false,
          offering,
          error: 'Offering is not configured for on-chain sync',
        };
      }

      const contractAddress = offering.contract_address;
      const onChain = await this.stellarClient.getOfferingState(contractAddress);

      const normalizedLocalStatus = normalizeOfferingStatus(offering.status);
      const normalizedChainStatus = normalizeOnChainStatus(onChain.status);

      if (!normalizedChainStatus) {
        this.logger.error('Received unsupported on-chain offering status', {
          offeringId: offering.id,
          contractAddress,
          chainStatus: onChain.status,
        });

        return {
          offeringId: offering.id,
          contractAddress,
          success: false,
          updated: false,
          offering,
          error: 'On-chain offering state is invalid',
        };
      }

      if (
        normalizedLocalStatus &&
        !canTransition(normalizedLocalStatus, normalizedChainStatus)
      ) {
        this.logger.warn('Rejected incompatible on-chain offering transition', {
          offeringId: offering.id,
          contractAddress,
          currentStatus: normalizedLocalStatus,
          chainStatus: normalizedChainStatus,
        });

        return {
          offeringId: offering.id,
          contractAddress,
          success: false,
          updated: false,
          offering,
          error: 'On-chain status is not compatible with catalog state',
        };
      }

      const hasChanged =
        normalizedChainStatus !== normalizedLocalStatus ||
        onChain.total_raised !== offering.total_raised;

      if (!hasChanged) {
        return {
          offeringId: offering.id,
          contractAddress,
          success: true,
          updated: false,
          offering: {
            ...offering,
            status: normalizedChainStatus,
            total_raised: onChain.total_raised,
          },
        };
      }

      const update: UpdateOfferingStateInput = {
        status: normalizedChainStatus,
        total_raised: onChain.total_raised,
      };

      const updatedOffering =
        (await this.offeringRepository.updateState(offering.id, update)) ?? {
          ...offering,
          ...update,
        };

      this.logger.info('Offering catalog synchronized with on-chain state', {
        offeringId: offering.id,
        contractAddress,
        previousStatus: normalizedLocalStatus ?? null,
        nextStatus: normalizedChainStatus,
        totalRaised: onChain.total_raised,
      });

      return {
        offeringId: offering.id,
        contractAddress,
        success: true,
        updated: true,
        offering: updatedOffering,
      };
    } catch (error) {
      const failureClass = classifyStellarRPCFailure(error);

      this.logger.error('Offering sync failed against Stellar dependency', {
        offeringId: offering.id,
        contractAddress: offering.contract_address ?? '',
        failureClass,
        error,
      });

      return {
        offeringId: offering.id,
        contractAddress: offering.contract_address ?? '',
        success: false,
        updated: false,
        offering,
        error: 'Unable to sync offering from Stellar',
        failureClass,
      };
    }
  }

  async syncAll(): Promise<SyncResult[]> {
    const offerings = await this.offeringRepository.listAll();
    const results = await Promise.allSettled(
      offerings.map((offering) => this.syncOfferingRecord(offering)),
    );

    return results.map((result, index) => {
      if (result.status === 'fulfilled') {
        return result.value;
      }

      const offering = offerings[index];
      const failureClass = classifyStellarRPCFailure(result.reason);

      this.logger.error('Offering sync task failed unexpectedly', {
        offeringId: offering.id,
        contractAddress: offering.contract_address ?? '',
        failureClass,
        error: result.reason,
      });

      return {
        offeringId: offering.id,
        contractAddress: offering.contract_address ?? '',
        success: false,
        updated: false,
        offering,
        error: 'Unable to sync offering from Stellar',
        failureClass,
      };
    });
  }
}

export function getSynchronizedOffering(
  result: SyncResult,
  fallback: Offering,
): Offering {
  return result.offering ?? fallback;
}

function normalizeOnChainStatus(
  status: OnChainOfferingState['status'],
): UpdateOfferingStateInput['status'] | null {
  const normalized = normalizeOfferingStatus(status);

  if (
    normalized === 'draft' ||
    normalized === 'active' ||
    normalized === 'closed' ||
    normalized === 'completed'
  ) {
    return normalized;
  }

  return null;
}
