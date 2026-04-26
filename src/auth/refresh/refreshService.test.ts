import { RefreshService } from './refreshService';
import { RefreshTokenRepository, TokenService, RefreshTokenPayload } from './types';
import { withTransaction } from '../../db/transaction';

jest.mock('../../db/transaction');

describe('RefreshService', () => {
    let refreshService: RefreshService;
    let mockRepo: jest.Mocked<RefreshTokenRepository>;
    let mockTokenService: jest.Mocked<TokenService>;
    let mockDb: any;
    let mockWithTransaction: jest.MockedFunction<typeof withTransaction>;

    beforeEach(() => {
        mockRepo = {
            findSessionById: jest.fn(),
            findSessionByIdForUpdate: jest.fn(),
            createSession: jest.fn(),
            revokeSessionAndDescendants: jest.fn(),
            findSessionByParentId: jest.fn(),
        };
        mockTokenService = {
            verifyRefreshToken: jest.fn(),
            issueTokens: jest.fn(),
            hashToken: jest.fn(),
        };
        mockDb = {}; // Mock DB pool
        mockWithTransaction = withTransaction as jest.MockedFunction<typeof withTransaction>;
        mockWithTransaction.mockClear(); // Clear previous calls
        refreshService = new RefreshService(mockRepo, mockTokenService, mockDb);
    });

    const mockPayload: RefreshTokenPayload = {
        userId: 'user-123',
        sessionId: 'session-123',
        role: 'investor',
    };

    const mockTokens = {
        accessToken: 'new-access-token',
        refreshToken: 'new-refresh-token',
    };

    it('should rotate tokens successfully', async () => {
        const mockClient = {};
        mockWithTransaction.mockImplementation(async (db, callback) => {
            return await callback(mockClient as any);
        });

        mockTokenService.verifyRefreshToken.mockReturnValue(mockPayload);
        mockTokenService.issueTokens.mockReturnValue(mockTokens);
        mockRepo.findSessionByIdForUpdate.mockResolvedValue({ 
            id: 'session-123', 
            revoked_at: null,
            token_hash: 'hashed-token'
        });
        mockTokenService.hashToken.mockReturnValueOnce('hashed-token').mockReturnValueOnce('new-hash');
        mockRepo.createSession.mockResolvedValue({ id: 'new-session-id' });

        const result = await refreshService.refresh('old-token');

        expect(mockWithTransaction).toHaveBeenCalledWith(mockDb, expect.any(Function));
        expect(result).toEqual(mockTokens);
        expect(mockRepo.findSessionByIdForUpdate).toHaveBeenCalledWith('session-123', mockClient);
        expect(mockTokenService.hashToken).toHaveBeenCalledWith('old-token');
        expect(mockRepo.createSession).toHaveBeenCalled();
        expect(mockRepo.revokeSessionAndDescendants).not.toHaveBeenCalled();
    });

    it('should revoke session and descendants if token is reused (already has child)', async () => {
        const mockClient = {};
        mockWithTransaction.mockImplementation(async (db, callback) => {
            return await callback(mockClient as any);
        });

        mockTokenService.verifyRefreshToken.mockReturnValue(mockPayload);
        mockRepo.findSessionByIdForUpdate.mockResolvedValue({ 
            id: 'session-123', 
            revoked_at: null,
            token_hash: 'hashed-token'
        });
        mockTokenService.hashToken.mockReturnValue('hashed-token');
        mockRepo.findSessionByParentId.mockResolvedValue({ id: 'child-session-id' });

        const result = await refreshService.refresh('reused-token');

        expect(result).toBeNull();
        expect(mockRepo.revokeSessionAndDescendants).toHaveBeenCalledWith('session-123', mockClient);
    });

    it('should revoke session and descendants if session is already revoked', async () => {
        const mockClient = {};
        mockWithTransaction.mockImplementation(async (db, callback) => {
            return await callback(mockClient as any);
        });

        mockTokenService.verifyRefreshToken.mockReturnValue(mockPayload);
        mockRepo.findSessionByIdForUpdate.mockResolvedValue({ 
            id: 'session-123', 
            revoked_at: new Date(),
            token_hash: 'hashed-token'
        });
        mockTokenService.hashToken.mockReturnValue('hashed-token');

        const result = await refreshService.refresh('revoked-token');

        expect(result).toBeNull();
        expect(mockRepo.revokeSessionAndDescendants).toHaveBeenCalledWith('session-123', mockClient);
    });

    it('should return null if token verification fails', async () => {
        mockTokenService.verifyRefreshToken.mockImplementation(() => {
            throw new Error('Invalid token');
        });

        const result = await refreshService.refresh('invalid-token');

        expect(result).toBeNull();
        expect(mockWithTransaction).not.toHaveBeenCalled();
    });

    it('should return null if session is not found', async () => {
        const mockClient = {};
        mockWithTransaction.mockImplementation(async (db, callback) => {
            return await callback(mockClient as any);
        });

        mockTokenService.verifyRefreshToken.mockReturnValue(mockPayload);
        mockRepo.findSessionByIdForUpdate.mockResolvedValue(null);

        const result = await refreshService.refresh('unknown-token');

        expect(result).toBeNull();
        expect(mockWithTransaction).toHaveBeenCalled();
    });

    it('should revoke session if token hash does not match', async () => {
        const mockClient = {};
        mockWithTransaction.mockImplementation(async (db, callback) => {
            return await callback(mockClient as any);
        });

        mockTokenService.verifyRefreshToken.mockReturnValue(mockPayload);
        mockRepo.findSessionByIdForUpdate.mockResolvedValue({ 
            id: 'session-123', 
            revoked_at: null,
            token_hash: 'stored-hash'
        });
        mockTokenService.hashToken.mockReturnValue('different-hash');

        const result = await refreshService.refresh('tampered-token');

        expect(result).toBeNull();
        expect(mockRepo.revokeSessionAndDescendants).toHaveBeenCalledWith('session-123', mockClient);
    });
});
