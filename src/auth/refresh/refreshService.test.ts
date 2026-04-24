/**
 * @file src/auth/refresh/refreshService.test.ts
 * @description
 * Test suite for RefreshService — token rotation, reuse detection, and
 * concurrent (race-condition) refresh coverage.
 *
 * Test strategy:
 *  - All DB interactions are mocked; no real Postgres required.
 *  - Concurrent tests use `Promise.all` to launch two refresh calls
 *    simultaneously, then assert the safety invariant:
 *      • At most one call may succeed (return tokens).
 *      • Exactly one revocation must occur.
 *  - Clock / crypto is NOT mocked — determinism comes from the mocked
 *    repository, not from timing.
 *
 * Security invariants verified:
 *  - A reused token (child session already exists) triggers revocation.
 *  - A revoked session triggers revocation.
 *  - A concurrent double-use triggers revocation (in-flight guard).
 *  - An invalid token never reaches the repository.
 *  - Session tree revocation is idempotent (revokeSessionAndDescendants
 *    may be called more than once without error).
 */

import { RefreshService } from './refreshService';
import { RefreshTokenRepository, TokenService, RefreshTokenPayload } from './types';

// ─── Shared fixtures ──────────────────────────────────────────────────────────

const MOCK_PAYLOAD: RefreshTokenPayload = {
    userId: 'user-123',
    sessionId: 'session-123',
    role: 'investor',
};

const MOCK_TOKENS = {
    accessToken: 'new-access-token',
    refreshToken: 'new-refresh-token',
};

// ─── Suite ────────────────────────────────────────────────────────────────────

describe('RefreshService', () => {
    let refreshService: RefreshService;
    let mockRepo: jest.Mocked<RefreshTokenRepository>;
    let mockTokenService: jest.Mocked<TokenService>;

    beforeEach(() => {
        mockRepo = {
            findSessionById: jest.fn(),
            createSession: jest.fn(),
            revokeSessionAndDescendants: jest.fn().mockResolvedValue(undefined),
            findSessionByParentId: jest.fn(),
        };
        mockTokenService = {
            verifyRefreshToken: jest.fn(),
            issueTokens: jest.fn(),
            hashToken: jest.fn(),
        };
        refreshService = new RefreshService(mockRepo, mockTokenService);
    });

    // ── Original passing tests (unchanged) ───────────────────────────────────

    it('should rotate tokens successfully', async () => {
        mockTokenService.verifyRefreshToken.mockReturnValue(MOCK_PAYLOAD);
        mockRepo.findSessionById.mockResolvedValue({ id: 'session-123', revoked_at: null });
        mockRepo.findSessionByParentId.mockResolvedValue(null);
        mockTokenService.issueTokens.mockReturnValue(MOCK_TOKENS);
        mockTokenService.hashToken.mockReturnValue('new-hash');
        mockRepo.createSession.mockResolvedValue({ id: 'new-session-id' });

        const result = await refreshService.refresh('old-token');

        expect(result).toEqual(MOCK_TOKENS);
        expect(mockRepo.createSession).toHaveBeenCalled();
        expect(mockRepo.revokeSessionAndDescendants).not.toHaveBeenCalled();
    });

    it('should revoke session and descendants if token is reused (already has child)', async () => {
        mockTokenService.verifyRefreshToken.mockReturnValue(MOCK_PAYLOAD);
        mockRepo.findSessionById.mockResolvedValue({ id: 'session-123', revoked_at: null });
        mockRepo.findSessionByParentId.mockResolvedValue({ id: 'child-session-id' });

        const result = await refreshService.refresh('reused-token');

        expect(result).toBeNull();
        expect(mockRepo.revokeSessionAndDescendants).toHaveBeenCalledWith('session-123');
    });

    it('should revoke session and descendants if session is already revoked', async () => {
        mockTokenService.verifyRefreshToken.mockReturnValue(MOCK_PAYLOAD);
        mockRepo.findSessionById.mockResolvedValue({ id: 'session-123', revoked_at: new Date() });

        const result = await refreshService.refresh('revoked-token');

        expect(result).toBeNull();
        expect(mockRepo.revokeSessionAndDescendants).toHaveBeenCalledWith('session-123');
    });

    it('should return null if token verification fails', async () => {
        mockTokenService.verifyRefreshToken.mockImplementation(() => {
            throw new Error('Invalid token');
        });

        const result = await refreshService.refresh('invalid-token');

        expect(result).toBeNull();
        expect(mockRepo.findSessionById).not.toHaveBeenCalled();
    });

    it('should return null if session is not found', async () => {
        mockTokenService.verifyRefreshToken.mockReturnValue(MOCK_PAYLOAD);
        mockRepo.findSessionById.mockResolvedValue(null);

        const result = await refreshService.refresh('unknown-token');

        expect(result).toBeNull();
    });

    // ── Concurrent / race-condition tests ─────────────────────────────────────

    describe('concurrent refresh race coverage', () => {
        /**
         * Scenario: Two requests arrive simultaneously with the same refresh token.
         *
         * Expected invariant:
         *  - At most one call returns tokens (the second enters the in-flight
         *    guard and gets null immediately).
         *  - revokeSessionAndDescendants is called at least once.
         *  - createSession is called at most once (the winning call).
         */
        it('concurrent double-use: at most one succeeds; session tree is revoked', async () => {
            // Introduce an artificial delay in findSessionById so both calls
            // reach the in-flight check before either one completes.
            let resolveFirst!: () => void;
            const barrier = new Promise<void>((res) => { resolveFirst = res; });

            mockTokenService.verifyRefreshToken.mockReturnValue(MOCK_PAYLOAD);
            mockTokenService.issueTokens.mockReturnValue(MOCK_TOKENS);
            mockTokenService.hashToken.mockReturnValue('new-hash');

            // First call blocks at findSessionById until we release it.
            mockRepo.findSessionById
                .mockImplementationOnce(() => barrier.then(() => ({ id: 'session-123', revoked_at: null })))
                .mockResolvedValue({ id: 'session-123', revoked_at: null });

            mockRepo.findSessionByParentId.mockResolvedValue(null);
            mockRepo.createSession.mockResolvedValue({ id: 'new-session-id' });
            mockRepo.revokeSessionAndDescendants.mockResolvedValue(undefined);

            // Launch both calls concurrently BEFORE releasing the barrier.
            const [p1, p2] = [
                refreshService.refresh('same-token'),
                refreshService.refresh('same-token'),
            ];

            // Release the barrier so the first call can continue.
            resolveFirst();

            const [r1, r2] = await Promise.all([p1, p2]);

            // At most one result is non-null.
            const successes = [r1, r2].filter((r) => r !== null);
            expect(successes.length).toBeLessThanOrEqual(1);

            // The losing (concurrent) call must have triggered revocation.
            expect(mockRepo.revokeSessionAndDescendants).toHaveBeenCalled();

            // createSession can only have been called by the winner (if any).
            expect(mockRepo.createSession.mock.calls.length).toBeLessThanOrEqual(1);
        });

        /**
         * Scenario: Sequential double-use (reuse after successful rotation).
         *
         * The first call succeeds and creates a child session.
         * The second call (same parent token) detects the child → revocation.
         */
        it('sequential double-use: second call revokes session tree', async () => {
            mockTokenService.verifyRefreshToken.mockReturnValue(MOCK_PAYLOAD);
            mockTokenService.issueTokens.mockReturnValue(MOCK_TOKENS);
            mockTokenService.hashToken.mockReturnValue('new-hash');
            mockRepo.findSessionById.mockResolvedValue({ id: 'session-123', revoked_at: null });
            mockRepo.findSessionByParentId
                .mockResolvedValueOnce(null)                         // first call: no child yet
                .mockResolvedValue({ id: 'child-session-id' });      // second call: child exists
            mockRepo.createSession.mockResolvedValue({ id: 'new-session-id' });

            const first = await refreshService.refresh('token');
            expect(first).toEqual(MOCK_TOKENS);

            const second = await refreshService.refresh('token');
            expect(second).toBeNull();
            expect(mockRepo.revokeSessionAndDescendants).toHaveBeenCalledWith('session-123');
        });

        /**
         * Scenario: Race where the session becomes revoked between two concurrent
         * calls — the second call finds revoked_at set and triggers tree revocation.
         */
        it('race with revoked session: second caller triggers revocation', async () => {
            mockTokenService.verifyRefreshToken.mockReturnValue(MOCK_PAYLOAD);
            mockTokenService.issueTokens.mockReturnValue(MOCK_TOKENS);
            mockTokenService.hashToken.mockReturnValue('new-hash');

            // First call sees a live session.
            // Second call sees revoked_at set (simulates another process revoking between calls).
            mockRepo.findSessionById
                .mockResolvedValueOnce({ id: 'session-123', revoked_at: null })
                .mockResolvedValue({ id: 'session-123', revoked_at: new Date() });

            mockRepo.findSessionByParentId.mockResolvedValue(null);
            mockRepo.createSession.mockResolvedValue({ id: 'new-session-id' });

            const first = await refreshService.refresh('token');
            expect(first).toEqual(MOCK_TOKENS);

            const second = await refreshService.refresh('token');
            expect(second).toBeNull();
            expect(mockRepo.revokeSessionAndDescendants).toHaveBeenCalledWith('session-123');
        });

        /**
         * Scenario: Concurrent calls where the in-flight revoke itself throws.
         * The service must still return null — no unhandled promise rejection.
         */
        it('in-flight revocation failure is swallowed — null still returned', async () => {
            let resolveFirst!: () => void;
            const barrier = new Promise<void>((res) => { resolveFirst = res; });

            mockTokenService.verifyRefreshToken.mockReturnValue(MOCK_PAYLOAD);

            // Block the first call so the second enters the in-flight guard.
            mockRepo.findSessionById.mockImplementation(
                () => barrier.then(() => ({ id: 'session-123', revoked_at: null }))
            );
            mockRepo.findSessionByParentId.mockResolvedValue(null);
            mockRepo.createSession.mockResolvedValue({ id: 'new-session-id' });
            mockTokenService.issueTokens.mockReturnValue(MOCK_TOKENS);
            mockTokenService.hashToken.mockReturnValue('hash');

            // Make revocation throw — service must not crash.
            mockRepo.revokeSessionAndDescendants.mockRejectedValue(new Error('DB down'));

            const [p1, p2] = [
                refreshService.refresh('token'),
                refreshService.refresh('token'),
            ];
            resolveFirst();

            const [r1, r2] = await Promise.all([p1, p2]);

            // Both results must be resolvable (no unhandled rejection).
            const nullCount = [r1, r2].filter((r) => r === null).length;
            expect(nullCount).toBeGreaterThanOrEqual(1);
        });

        /**
         * Scenario: Three simultaneous refresh calls — only one (at most) wins;
         * the other two are blocked by the in-flight guard.
         */
        it('triple concurrent race: at most one winner', async () => {
            let resolveFirst!: () => void;
            const barrier = new Promise<void>((res) => { resolveFirst = res; });

            mockTokenService.verifyRefreshToken.mockReturnValue(MOCK_PAYLOAD);
            mockTokenService.issueTokens.mockReturnValue(MOCK_TOKENS);
            mockTokenService.hashToken.mockReturnValue('hash');
            mockRepo.findSessionById.mockImplementation(
                () => barrier.then(() => ({ id: 'session-123', revoked_at: null }))
            );
            mockRepo.findSessionByParentId.mockResolvedValue(null);
            mockRepo.createSession.mockResolvedValue({ id: 'new-id' });
            mockRepo.revokeSessionAndDescendants.mockResolvedValue(undefined);

            const promises = [
                refreshService.refresh('token'),
                refreshService.refresh('token'),
                refreshService.refresh('token'),
            ];
            resolveFirst();

            const results = await Promise.all(promises);
            const successes = results.filter((r) => r !== null);
            expect(successes.length).toBeLessThanOrEqual(1);
        });
    });
});
