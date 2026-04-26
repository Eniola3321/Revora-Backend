import { DistributionRepository } from '../db/repositories/distributionRepository';
import { InvestmentRepository } from '../db/repositories/investmentRepository';
import { Offering, OfferingRepository } from '../db/repositories/offeringRepository';
import { Logger, globalLogger } from '../lib/logger';
import {
  getSynchronizedOffering,
  OfferingSyncService,
  SyncResult,
} from '../services/offeringSyncService';

export interface OfferingStats {
  offeringId: string;
  totalInvested: string;
  totalDistributed: string;
  investorCount: number;
  lastReportDate: Date | null;
}

export interface OfferingServiceOptions {
  offeringSyncService?: OfferingSyncService;
  logger?: Logger;
}

export class OfferingService {
  private catalogCache: { data: Offering[]; timestamp: number } | null = null;
  private readonly cacheTtlMs = 60 * 1000;
  private readonly logger: Logger;

  constructor(
    private readonly investmentRepo: Pick<InvestmentRepository, 'getAggregateStats'>,
    private readonly distributionRepo: Pick<DistributionRepository, 'getAggregateStats'>,
    private readonly offeringRepo: Pick<OfferingRepository, 'listCatalog'>,
    private readonly options: OfferingServiceOptions = {},
  ) {
    this.logger = (options.logger ?? globalLogger).child({
      module: 'OfferingService',
    });
  }

  async getOfferingStats(offeringId: string): Promise<OfferingStats> {
    const [investmentStats, distributionStats] = await Promise.all([
      this.investmentRepo.getAggregateStats(offeringId),
      this.distributionRepo.getAggregateStats(offeringId),
    ]);

    return {
      offeringId,
      totalInvested: investmentStats.totalInvested,
      totalDistributed: distributionStats.totalDistributed,
      investorCount: investmentStats.investorCount,
      lastReportDate: distributionStats.lastReportDate,
    };
  }

  async getCatalog(
    limit = 10,
    offset = 0,
    statuses = ['active', 'completed'],
  ): Promise<Offering[]> {
    const isCacheableRequest =
      limit === 10 &&
      offset === 0 &&
      statuses.length === 2 &&
      statuses.includes('active') &&
      statuses.includes('completed');

    if (isCacheableRequest && this.catalogCache) {
      const now = Date.now();
      if (now - this.catalogCache.timestamp < this.cacheTtlMs) {
        return this.catalogCache.data;
      }
    }

    const catalog = await this.offeringRepo.listCatalog({ limit, offset, statuses });
    const synchronizedCatalog = this.options.offeringSyncService
      ? await this.syncCatalogWithChain(catalog)
      : catalog;

    if (isCacheableRequest) {
      this.catalogCache = {
        data: synchronizedCatalog,
        timestamp: Date.now(),
      };
    }

    return synchronizedCatalog;
  }

  private async syncCatalogWithChain(catalog: Offering[]): Promise<Offering[]> {
    if (catalog.length === 0) {
      return catalog;
    }

    const results = await Promise.all(
      catalog.map((offering) =>
        this.options.offeringSyncService!.syncOfferingRecord(offering),
      ),
    );

    const failedSyncs = results.filter((result) => !result.success);
    if (failedSyncs.length > 0) {
      this.logger.warn('Catalog sync completed with partial on-chain failures', {
        failedOfferingIds: failedSyncs.map((result) => result.offeringId),
        failureClasses: failedSyncs
          .map((result) => result.failureClass)
          .filter((value): value is NonNullable<SyncResult['failureClass']> => value !== undefined),
      });
    }

    return results.map((result, index) =>
      getSynchronizedOffering(result, catalog[index]),
    );
  }
}
