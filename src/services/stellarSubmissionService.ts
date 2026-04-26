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
   * Submits a simple payment transaction with enhanced error handling.
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
   * Invokes a Soroban contract with enhanced error handling.
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

  /**
   * Helper method to get account with retry logic.
   */
  private async getAccountWithRetry(
    publicKey: string,
    context: StellarRPCFailureContext
  ): Promise<any> {
    let attemptCount = context.attemptCount || 1;
    
    while (attemptCount <= 3) {
      try {
        return await this.server.getAccount(publicKey);
      } catch (error) {
        const failure = classifyStellarRPCFailure(error, {
          ...context,
          operation: 'get_account',
          attemptCount,
        });
        
        if (!shouldRetryStellarRPCFailure(failure)) {
          throw this.createAppErrorFromFailure(failure);
        }
        
        this.logStellarFailure(failure);
        
        if (failure.suggestedRetryDelayMs) {
          await this.delay(failure.suggestedRetryDelayMs);
        }
        
        attemptCount++;
      }
    }
    
    throw Errors.serviceUnavailable('Failed to retrieve Stellar account after multiple attempts');
  }

  /**
   * Helper method to send transaction with retry logic.
   */
  private async sendTransactionWithRetry(
    transaction: StellarSdk.Transaction,
    context: StellarRPCFailureContext
  ): Promise<StellarSdk.rpc.Api.SendTransactionResponse> {
    let attemptCount = context.attemptCount || 1;
    
    while (attemptCount <= 3) {
      try {
        const result = await this.server.sendTransaction(transaction);
        
        // Handle transaction submission results
        if (result.status === 'PENDING') {
          return result;
        } else if (result.status === 'DUPLICATE') {
          throw Errors.conflict('Transaction already submitted', {
            hash: result.hash,
          });
        } else if (result.status === 'TRY_AGAIN_LATER') {
          throw new Error('Transaction rate limited, try again later');
        } else {
          throw new Error(`Transaction failed: ${result.status}`);
        }
      } catch (error) {
        const failure = classifyStellarRPCFailure(error, {
          ...context,
          operation: 'send_transaction',
          attemptCount,
          transactionHash: transaction.hash().toString('hex'),
        });
        
        if (!shouldRetryStellarRPCFailure(failure)) {
          throw this.createAppErrorFromFailure(failure);
        }
        
        this.logStellarFailure(failure);
        
        if (failure.suggestedRetryDelayMs) {
          await this.delay(failure.suggestedRetryDelayMs);
        }
        
        attemptCount++;
      }
    }
    
    throw Errors.serviceUnavailable('Failed to submit Stellar transaction after multiple attempts');
  }

  /**
   * Creates an AppError from a Stellar RPC failure.
   */
  private createAppErrorFromFailure(failure: StellarRPCFailure): AppError {
    const errorResponse = createStellarErrorResponse(failure);
    
    switch (failure.class) {
      case StellarRPCFailureClass.TIMEOUT:
        return Errors.serviceUnavailable(errorResponse.message, errorResponse.details);
      
      case StellarRPCFailureClass.RATE_LIMIT:
        return Errors.serviceUnavailable(errorResponse.message, errorResponse.details);
      
      case StellarRPCFailureClass.UPSTREAM_ERROR:
        return Errors.serviceUnavailable(errorResponse.message, errorResponse.details);
      
      case StellarRPCFailureClass.NETWORK_ERROR:
        return Errors.serviceUnavailable(errorResponse.message, errorResponse.details);
      
      case StellarRPCFailureClass.UNAUTHORIZED:
        return Errors.unauthorized(errorResponse.message);
      
      case StellarRPCFailureClass.TRANSACTION_FAILED:
        return Errors.badRequest(errorResponse.message, errorResponse.details);
      
      case StellarRPCFailureClass.BAD_SEQUENCE:
        return Errors.badRequest(errorResponse.message, errorResponse.details);
      
      case StellarRPCFailureClass.SIGNING_ERROR:
        return Errors.internal(errorResponse.message, errorResponse.details);
      
      default:
        return Errors.serviceUnavailable(errorResponse.message, errorResponse.details);
    }
  }

  /**
   * Logs Stellar RPC failures for monitoring and debugging.
   */
  private logStellarFailure(failure: StellarRPCFailure): void {
    logger.warn('Stellar RPC operation failed', {
      failureClass: failure.class,
      operation: failure.context.operation,
      network: failure.context.network,
      attemptCount: failure.context.attemptCount,
      shouldRetry: failure.shouldRetry,
      suggestedDelay: failure.suggestedRetryDelayMs,
      originalError: failure.originalError,
      contractId: failure.context.contractId,
      functionName: failure.context.functionName,
      transactionHash: failure.context.transactionHash,
    });
  }

  /**
   * Utility method for delaying execution.
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
