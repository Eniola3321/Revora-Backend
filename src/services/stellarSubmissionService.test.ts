import * as StellarSdk from '@stellar/stellar-sdk';
import { StellarSubmissionService } from './stellarSubmissionService';
import { env } from '../config/env';

// Mock env
jest.mock('../config/env', () => ({
  env: {
    STELLAR_HORIZON_URL: 'https://horizon.stellar.org',
    STELLAR_TIMEOUT: 30000,
    STELLAR_MAX_FEE: 100000,
    STELLAR_NETWORK_PASSPHRASE: 'Public Global Stellar Network ; September 2015',
    STELLAR_NETWORK: 'public',
  },
}));

jest.mock('@stellar/stellar-sdk', () => {
  return {
    rpc: {
      Server: jest.fn().mockImplementation(() => ({
        getAccount: jest.fn().mockResolvedValue({
          accountId: () => 'G-MOCK-PUBLIC-KEY',
          sequenceNumber: () => '1',
          incrementSequenceNumber: jest.fn(),
        }),
        sendTransaction: jest
          .fn()
          .mockResolvedValue({ 
            hash: 'mock-hash', 
            status: 'PENDING',
            latestLedger: 12345,
            latestLedgerCloseTime: 1234567890,
          }),
      })),
    },
    Keypair: {
      fromSecret: jest.fn().mockReturnValue({
        publicKey: jest.fn().mockReturnValue('G-MOCK-PUBLIC-KEY'),
        sign: jest.fn(),
      }),
    },
    Asset: {
      native: jest.fn().mockReturnValue({ 
        isNative: jest.fn().mockReturnValue(true),
        getAssetCode: jest.fn().mockReturnValue('XLM')
      }),
    },
    TransactionBuilder: jest.fn().mockImplementation(() => ({
      addOperation: jest.fn().mockReturnThis(),
      setTimeout: jest.fn().mockReturnThis(),
      build: jest.fn().mockReturnValue(mockTransaction),
    })),
    Operation: {
      payment: jest.fn(),
      invokeContractFunction: jest.fn(),
    },
    BASE_FEE: '100',
    Networks: {
      TESTNET: 'Test SDF Network ; September 2015',
      PUBLIC: 'Public Global Stellar Network ; September 2015',
    },
  };
});

// Mock environment
jest.mock('../config/env', () => ({
  env: {
    STELLAR_NETWORK: 'testnet',
    STELLAR_NETWORK_PASSPHRASE: 'Test SDF Network ; September 2015',
  },
}));

describe('StellarSubmissionService', () => {
  let service: StellarSubmissionService;
  let mockServer: jest.Mocked<StellarSdk.rpc.Server>;
  const mockSecret = 'SAXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';

  beforeEach(() => {
    process.env.STELLAR_SERVER_SECRET = mockSecret;
    jest.clearAllMocks();
    service = new StellarSubmissionService();
    mockServer = (StellarSdk.rpc.Server as jest.Mock).mock.results[0].value;
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('should initialize with the correct horizon URL and keypair', () => {
    expect(StellarSdk.Keypair.fromSecret).toHaveBeenCalledWith(mockSecret);
    expect(StellarSdk.rpc.Server).toHaveBeenCalled();
  });

  it('should throw error if secret is missing', () => {
    const originalSecret = process.env.STELLAR_SERVER_SECRET;
    delete process.env.STELLAR_SERVER_SECRET;
    expect(() => new StellarSubmissionService()).toThrow(
      'STELLAR_SERVER_SECRET is not defined in environment variables',
    );
    process.env.STELLAR_SERVER_SECRET = originalSecret;
  });

  it('should throw error if secret is invalid', () => {
    (StellarSdk.Keypair.fromSecret as jest.Mock).mockImplementationOnce(() => {
      throw new Error('invalid secret');
    });
    expect(() => new StellarSubmissionService()).toThrow(
      'Invalid STELLAR_SERVER_SECRET provided'
    );
  });

  it('should submit a payment successfully', async () => {
    const to = 'G-DESTINATION';
    const amount = '10.0';

    const result = await service.submitPayment(to, amount);

    expect(result).toEqual({ hash: 'mock-hash', status: 'PENDING' });
    expect(StellarSdk.Operation.payment).toHaveBeenCalledWith({
      destination: to,
      amount,
      asset: expect.anything(),
    });
    expect(StellarSdk.TransactionBuilder).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        fee: '100000', // Should use env.STELLAR_MAX_FEE
        networkPassphrase: env.STELLAR_NETWORK_PASSPHRASE,
      })
    );
  });

  it('should submit a payment with a non-native asset', async () => {
    const to = 'G-DESTINATION';
    const amount = '10.0';
    const asset = {
      isNative: jest.fn().mockReturnValue(false),
      getAssetCode: jest.fn().mockReturnValue('USDC'),
    } as any;

    const result = await service.submitPayment(to, amount, asset);

    expect(result).toEqual({ hash: 'mock-hash', status: 'SUCCESS' });
    expect(asset.isNative).toHaveBeenCalled();
    expect(StellarSdk.Operation.payment).toHaveBeenCalledWith({
      destination: to,
      amount,
      asset,
    });
  });

  it('should throw serviceUnavailable when transaction submission fails', async () => {
    (StellarSdk.rpc.Server as jest.Mock).mockImplementationOnce(() => ({
      getAccount: jest.fn().mockResolvedValue({ sequenceNumber: () => '1', incrementSequenceNumber: jest.fn() }),
      sendTransaction: jest.fn().mockRejectedValue(new Error('submit failure')),
    }));

    const localService = new StellarSubmissionService();

    await expect(localService.submitPayment('G-DESTINATION', '10.0')).rejects.toThrow(
      'Failed to submit payment transaction'
    );
  });

  it('should re-throw AppError from transaction failures', async () => {
    const appError = new Error('AppError occurred');
    appError.name = 'AppError';

    (StellarSdk.rpc.Server as jest.Mock).mockImplementationOnce(() => ({
      getAccount: jest.fn().mockResolvedValue({ sequenceNumber: () => '1', incrementSequenceNumber: jest.fn() }),
      sendTransaction: jest.fn().mockRejectedValue(appError),
    }));

    const localService = new StellarSubmissionService();

    await expect(localService.submitPayment('G-DESTINATION', '10.0')).rejects.toThrow(
      'AppError occurred'
    );
  });

  it('should throw validation error for invalid destination', async () => {
    await expect(service.submitPayment('', '10.0')).rejects.toThrow(
      'Destination public key must be a non-empty string'
    );
  });

  it('should throw validation error for invalid amount', async () => {
    await expect(service.submitPayment('G-DESTINATION', '')).rejects.toThrow(
      'Amount must be a non-empty string'
    );
  });

  it('should return the public key', () => {
    expect(service.getPublicKey()).toBe('G-MOCK-PUBLIC-KEY');
  });

  it('should throw error on invokeContract as it is a placeholder', async () => {
    await expect(service.invokeContract('CID', 'func')).rejects.toThrow(
      'Soroban contract invocation not implemented yet',
    );
  });
});
