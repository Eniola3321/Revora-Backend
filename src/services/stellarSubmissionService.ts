import * as StellarSdk from '@stellar/stellar-sdk';
import { env } from '../config/env';
import { globalLogger } from '../lib/logger';
import { Errors } from '../lib/errors';

/**
 * Service for building and submitting Stellar transactions.
 */
export class StellarSubmissionService {
  private server: StellarSdk.rpc.Server;
  private keypair: StellarSdk.Keypair;
  private logger = globalLogger.child({ service: 'stellar-submission' });

  constructor() {
    const horizonUrl =
      env.STELLAR_HORIZON_URL ||
      (env.STELLAR_NETWORK === 'public'
        ? 'https://horizon.stellar.org'
        : 'https://horizon-testnet.stellar.org');

    this.server = new StellarSdk.rpc.Server(horizonUrl);

    const secret = process.env.STELLAR_SERVER_SECRET;
    if (!secret) {
      throw Errors.internal('STELLAR_SERVER_SECRET is not defined in environment variables');
    }

    try {
      this.keypair = StellarSdk.Keypair.fromSecret(secret);
    } catch {
      throw Errors.internal('Invalid STELLAR_SERVER_SECRET provided');
    }

    this.logger.info('Stellar submission service initialized', {
      serverUrl: horizonUrl,
      publicKey: this.keypair.publicKey(),
      network: env.STELLAR_NETWORK,
      maxFee: env.STELLAR_MAX_FEE,
    });
  }

  /**
   * Submits a simple payment transaction.
   * @param to Destination public key
   * @param amount Amount to send (as string)
   * @param asset Asset to send (defaults to native XLM)
   * @returns Transaction result
   */
  async submitPayment(
    to: string,
    amount: string,
    asset: StellarSdk.Asset = StellarSdk.Asset.native(),
  ) {
    if (!to || typeof to !== 'string') {
      throw Errors.validationError('Destination public key must be a non-empty string');
    }
    if (!amount || typeof amount !== 'string') {
      throw Errors.validationError('Amount must be a non-empty string');
    }

    this.logger.info('Submitting payment transaction', {
      to,
      amount,
      asset: asset.isNative() ? 'XLM' : asset.getAssetCode(),
    });

    try {
      const sourceAccount = await this.server.getAccount(this.keypair.publicKey());

      const transaction = new StellarSdk.TransactionBuilder(sourceAccount, {
        fee: env.STELLAR_MAX_FEE.toString(),
        networkPassphrase: env.STELLAR_NETWORK_PASSPHRASE ||
          (env.STELLAR_NETWORK === 'public'
            ? StellarSdk.Networks.PUBLIC
            : StellarSdk.Networks.TESTNET),
      })
        .addOperation(
          StellarSdk.Operation.payment({
            destination: to,
            asset,
            amount,
          }),
        )
        .setTimeout(30)
        .build();

      transaction.sign(this.keypair);

      const result = await this.server.sendTransaction(transaction);

      this.logger.info('Payment transaction submitted successfully', {
        to,
        amount,
        transactionHash: result.hash,
      });

      return result;
    } catch (error) {
      this.logger.error('Payment transaction failed', {
        to,
        amount,
        error: error,
      });

      if (error instanceof Error && error.name === 'AppError') {
        throw error;
      }

      throw Errors.serviceUnavailable('Failed to submit payment transaction');
    }
  }

  /**
   * Invokes a Soroban contract (placeholder for logic).
   */
  async invokeContract(
    _contractId: string,
    _functionName: string,
    _args: any[] = [],
  ): Promise<never> {
    this.logger.warn('Soroban contract invocation attempted but not implemented', {
      contractId: _contractId,
      functionName: _functionName,
    });
    throw Errors.serviceUnavailable('Soroban contract invocation not implemented yet');
  }

  /**
   * Gets the public key of the service's keypair.
   */
  getPublicKey(): string {
    return this.keypair.publicKey();
  }
}
