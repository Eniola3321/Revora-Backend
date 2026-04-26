/**
 * Unit tests for StellarRpcClient
 * 
 * Tests the Stellar RPC client abstraction for querying network state.
 * Uses mocking to avoid actual network calls during testing.
 */

import {
  StellarRpcClient,
  StellarRpcClientImpl,
  createStellarRpcClient,
} from './stellarRpcClient';
import { SorobanRpc } from '@stellar/stellar-sdk';

// Mock the @stellar/stellar-sdk module
jest.mock('@stellar/stellar-sdk', () => ({
  SorobanRpc: {
    Server: jest.fn(),
  },
}));

describe('StellarRpcClientImpl', () => {
  let mockServer: jest.Mocked<SorobanRpc.Server>;
  let client: StellarRpcClient;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useRealTimers();

    // Create mock server instance
    mockServer = {
      getLatestLedger: jest.fn(),
    } as unknown as jest.Mocked<SorobanRpc.Server>;

    // Mock the Server constructor to return our mock instance
    (SorobanRpc.Server as jest.MockedClass<typeof SorobanRpc.Server>).mockImplementation(
      () => mockServer
    );

    client = new StellarRpcClientImpl({
      serverUrl: 'https://soroban-testnet.stellar.org',
      timeout: 5000,
    });
  });

  describe('getLatestLedger', () => {
    it('should fetch latest ledger sequence successfully', async () => {
      const mockResponse = { sequence: 12345 };
      mockServer.getLatestLedger.mockResolvedValue(mockResponse as any);

      const result = await client.getLatestLedger();

      expect(mockServer.getLatestLedger).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ sequence: 12345 });
    });

    it('should handle large ledger sequence numbers', async () => {
      const mockResponse = { sequence: 999999999 };
      mockServer.getLatestLedger.mockResolvedValue(mockResponse as any);

      const result = await client.getLatestLedger();

      expect(result).toEqual({ sequence: 999999999 });
    });

    it('should throw error for negative sequence numbers', async () => {
      const mockResponse = { sequence: -1 };
      mockServer.getLatestLedger.mockResolvedValue(mockResponse as any);

      await expect(client.getLatestLedger()).rejects.toThrow(
        'Invalid response: sequence number cannot be negative'
      );
    });

    it('should throw error for missing sequence number', async () => {
      const mockResponse = {};
      mockServer.getLatestLedger.mockResolvedValue(mockResponse as any);

      await expect(client.getLatestLedger()).rejects.toThrow(
        'Invalid response: missing or invalid sequence number'
      );
    });

    it('should throw error for invalid sequence type', async () => {
      const mockResponse = { sequence: 'invalid' };
      mockServer.getLatestLedger.mockResolvedValue(mockResponse as any);

      await expect(client.getLatestLedger()).rejects.toThrow(
        'Invalid response: missing or invalid sequence number'
      );
    });

    it('should handle network errors gracefully', async () => {
      mockServer.getLatestLedger.mockRejectedValue(
        new Error('Network connection failed')
      );

      await expect(client.getLatestLedger()).rejects.toThrow(
        'RPC client error: Network connection failed'
      );
    });

    it('should handle timeout errors', async () => {
      jest.useFakeTimers();

      // Create a new client with short timeout for testing
      const timeoutClient = new StellarRpcClientImpl({
        serverUrl: 'https://soroban-testnet.stellar.org',
        timeout: 100,
      });

      // Mock a slow response that never resolves
      mockServer.getLatestLedger.mockImplementation(
        () =>
          new Promise((resolve) => {
            setTimeout(() => resolve({ sequence: 12345 } as any), 10000);
          })
      );

      const promise = timeoutClient.getLatestLedger();

      // Fast-forward time to trigger timeout
      jest.advanceTimersByTime(100);

      await expect(promise).rejects.toThrow('RPC request timeout after 100ms');

      jest.useRealTimers();
    });

    it('should sanitize non-Error exceptions', async () => {
      mockServer.getLatestLedger.mockRejectedValue('string error');

      await expect(client.getLatestLedger()).rejects.toThrow(
        'RPC client error: unknown error occurred'
      );
    });

    it('should preserve timeout error messages', async () => {
      mockServer.getLatestLedger.mockRejectedValue(
        new Error('RPC request timeout after 5000ms')
      );

      await expect(client.getLatestLedger()).rejects.toThrow(
        'RPC request timeout after 5000ms'
      );
    });

    it('should preserve validation error messages', async () => {
      const mockResponse = { sequence: -1 };
      mockServer.getLatestLedger.mockResolvedValue(mockResponse as any);

      await expect(client.getLatestLedger()).rejects.toThrow(
        'Invalid response: sequence number cannot be negative'
      );
    });
  });

  describe('constructor configuration', () => {
    it('should use default server URL when not provided', () => {
      const defaultClient = new StellarRpcClientImpl();

      expect(SorobanRpc.Server).toHaveBeenCalledWith(
        'https://soroban-testnet.stellar.org',
        expect.objectContaining({
          allowHttp: false,
        })
      );
    });

    it('should use environment variable for server URL', () => {
      const originalEnv = process.env.STELLAR_RPC_URL;
      process.env.STELLAR_RPC_URL = 'https://custom-rpc.stellar.org';

      const envClient = new StellarRpcClientImpl();

      expect(SorobanRpc.Server).toHaveBeenCalledWith(
        'https://custom-rpc.stellar.org',
        expect.objectContaining({
          allowHttp: false,
        })
      );

      // Restore original env
      if (originalEnv) {
        process.env.STELLAR_RPC_URL = originalEnv;
      } else {
        delete process.env.STELLAR_RPC_URL;
      }
    });

    it('should use custom server URL from config', () => {
      const customClient = new StellarRpcClientImpl({
        serverUrl: 'https://mainnet-rpc.stellar.org',
      });

      expect(SorobanRpc.Server).toHaveBeenCalledWith(
        'https://mainnet-rpc.stellar.org',
        expect.objectContaining({
          allowHttp: false,
        })
      );
    });

    it('should allow HTTP for local testing', () => {
      const localClient = new StellarRpcClientImpl({
        serverUrl: 'http://localhost:8000',
      });

      expect(SorobanRpc.Server).toHaveBeenCalledWith(
        'http://localhost:8000',
        expect.objectContaining({
          allowHttp: true,
        })
      );
    });

    it('should use default timeout when not provided', () => {
      const defaultClient = new StellarRpcClientImpl();
      expect(defaultClient).toBeDefined();
    });

    it('should use custom timeout from config', () => {
      const customClient = new StellarRpcClientImpl({
        timeout: 10000,
      });
      expect(customClient).toBeDefined();
    });
  });
});

describe('createStellarRpcClient factory function', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should create a client with default config', () => {
    const client = createStellarRpcClient();
    expect(client).toBeInstanceOf(StellarRpcClientImpl);
  });

  it('should create a client with custom config', () => {
    const client = createStellarRpcClient({
      serverUrl: 'https://custom-rpc.stellar.org',
      timeout: 3000,
    });
    expect(client).toBeInstanceOf(StellarRpcClientImpl);
  });

  it('should return an object implementing StellarRpcClient interface', () => {
    const client = createStellarRpcClient();
    expect(client).toHaveProperty('getLatestLedger');
    expect(typeof client.getLatestLedger).toBe('function');
  });
});
