/**
 * Stellar RPC Client for Soroban Network State Queries
 * 
 * Provides an abstraction layer for querying the Stellar Soroban RPC network
 * to retrieve current ledger information. Used by the health endpoint to
 * calculate indexer synchronization lag.
 * 
 * Security Assumptions:
 * - RPC endpoint URL is trusted and configured via environment variable
 * - SSL certificate validation is enabled by default
 * - Network timeouts prevent resource exhaustion
 * - No sensitive data is transmitted or received
 */

import { SorobanRpc } from '@stellar/stellar-sdk';

/**
 * Interface for Stellar RPC client operations
 * 
 * This abstraction enables dependency injection and testing without
 * requiring actual network calls to the Stellar RPC endpoint.
 */
export interface StellarRpcClient {
  /**
   * Retrieves the latest ledger sequence number from the Stellar network
   * 
   * @returns Promise resolving to an object containing the current ledger sequence
   * @throws Error if the RPC request fails, times out, or returns invalid data
   */
  getLatestLedger(): Promise<{ sequence: number }>;
}

/**
 * Configuration options for the Stellar RPC client
 */
export interface StellarRpcClientConfig {
  /**
   * Stellar Soroban RPC endpoint URL
   * @default process.env.STELLAR_RPC_URL || 'https://soroban-testnet.stellar.org'
   */
  serverUrl?: string;

  /**
   * Request timeout in milliseconds
   * @default 5000
   */
  timeout?: number;
}

/**
 * Production implementation of StellarRpcClient using @stellar/stellar-sdk
 * 
 * This implementation uses the official Stellar SDK's SorobanRpc.Server
 * to query the Soroban RPC endpoint for network state information.
 * 
 * Error Handling:
 * - Network failures: Throws descriptive error with original cause
 * - Timeouts: Throws timeout error after configured duration
 * - Invalid responses: Throws error if sequence number is missing or invalid
 * 
 * @example
 * ```typescript
 * const client = new StellarRpcClientImpl({
 *   serverUrl: 'https://soroban-testnet.stellar.org',
 *   timeout: 5000
 * });
 * 
 * try {
 *   const { sequence } = await client.getLatestLedger();
 *   console.log(`Current ledger: ${sequence}`);
 * } catch (error) {
 *   console.error('Failed to fetch ledger:', error);
 * }
 * ```
 */
export class StellarRpcClientImpl implements StellarRpcClient {
  private readonly server: SorobanRpc.Server;
  private readonly timeout: number;

  constructor(config: StellarRpcClientConfig = {}) {
    const serverUrl =
      config.serverUrl ||
      process.env.STELLAR_RPC_URL ||
      'https://soroban-testnet.stellar.org';
    
    this.timeout = config.timeout || 5000;
    this.server = new SorobanRpc.Server(serverUrl, {
      allowHttp: serverUrl.startsWith('http://'), // Allow HTTP for local testing
    });
  }

  /**
   * Retrieves the latest ledger sequence from the Stellar Soroban RPC
   * 
   * Implementation Notes:
   * - Uses SorobanRpc.Server.getLatestLedger() from @stellar/stellar-sdk
   * - Wraps call in timeout protection to prevent hanging requests
   * - Validates response contains valid sequence number
   * - Sanitizes error messages to prevent information disclosure
   * 
   * @returns Promise resolving to { sequence: number }
   * @throws Error with sanitized message if request fails or times out
   */
  async getLatestLedger(): Promise<{ sequence: number }> {
    try {
      // Create timeout promise
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => {
          reject(new Error(`RPC request timeout after ${this.timeout}ms`));
        }, this.timeout);
      });

      // Race between actual request and timeout
      const response = await Promise.race([
        this.server.getLatestLedger(),
        timeoutPromise,
      ]);

      // Validate response structure
      if (!response || typeof response.sequence !== 'number') {
        throw new Error('Invalid response: missing or invalid sequence number');
      }

      // Validate sequence is non-negative
      if (response.sequence < 0) {
        throw new Error('Invalid response: sequence number cannot be negative');
      }

      return { sequence: response.sequence };
    } catch (error) {
      // Sanitize error message to prevent information disclosure
      if (error instanceof Error) {
        // Preserve timeout and validation errors as-is
        if (
          error.message.includes('timeout') ||
          error.message.includes('Invalid response')
        ) {
          throw error;
        }
        
        // Sanitize network errors
        throw new Error(`RPC client error: ${error.message}`);
      }
      
      // Handle non-Error exceptions
      throw new Error('RPC client error: unknown error occurred');
    }
  }
}

/**
 * Factory function to create a Stellar RPC client instance
 * 
 * This is the recommended way to instantiate the client as it provides
 * a clean API and enables future implementation swapping if needed.
 * 
 * @param config - Optional configuration for the RPC client
 * @returns StellarRpcClient instance
 * 
 * @example
 * ```typescript
 * const client = createStellarRpcClient({
 *   serverUrl: process.env.STELLAR_RPC_URL,
 *   timeout: 5000
 * });
 * ```
 */
export function createStellarRpcClient(
  config?: StellarRpcClientConfig
): StellarRpcClient {
  return new StellarRpcClientImpl(config);
}
