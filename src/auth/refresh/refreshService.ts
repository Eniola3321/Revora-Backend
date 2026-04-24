import crypto from 'node:crypto';
import {
    RefreshSuccessResponse,
    RefreshTokenRepository,
    TokenService,
} from './types';

/**
 * @module auth/refresh/RefreshService
 * @description
 * Stateless-safe refresh token rotation with reuse detection and concurrent
 * request deduplication.
 *
 * Security assumptions:
 *  - Each refresh token is single-use; using it a second time (even before the
 *    first response is returned) triggers full revocation of the session tree.
 *  - `findSessionByParentId` is the reuse-detection probe: if a child session
 *    already exists, the parent token has been consumed.
 *  - A concurrent double-use (two simultaneous calls with the same token) is
 *    handled by an in-flight `Set` keyed on `sessionId`.  The second concurrent
 *    caller is treated identically to a reuse attempt: the session tree is
 *    revoked and `null` is returned.
 *  - The in-flight lock is always released via `finally`; a DB crash cannot
 *    leave a session permanently locked.
 *  - `revokeSessionAndDescendants` is idempotent — safe to call multiple times.
 *
 * Abuse / failure paths:
 *  - Invalid / expired refresh token    → null  (no revocation)
 *  - Session not found                  → null
 *  - Session already revoked            → null + revokeSessionAndDescendants
 *  - Token already used (child present) → null + revokeSessionAndDescendants
 *  - Concurrent double-use              → null + revokeSessionAndDescendants
 */
export class RefreshService {
    /**
     * Tracks session IDs that are currently mid-refresh.
     * Prevents two concurrent calls from both succeeding with the same token.
     *
     * @dev The set holds string sessionIds.  It is cleared in a `finally` block
     *      so it cannot grow unbounded even under error conditions.
     */
    private readonly inFlightSessions = new Set<string>();

    constructor(
        private readonly repository: RefreshTokenRepository,
        private readonly tokenService: TokenService,
    ) {}

    /**
     * Rotate a refresh token.
     *
     * @param token - The raw refresh token from the client.
     * @returns     A new `{ accessToken, refreshToken }` pair on success,
     *              or `null` when the token is invalid, reused, or concurrently
     *              consumed.
     */
    async refresh(token: string): Promise<RefreshSuccessResponse | null> {
        // 1. Verify token signature / expiry
        let payload;
        try {
            payload = this.tokenService.verifyRefreshToken(token);
        } catch {
            return null;
        }

        const { sessionId, userId, role } = payload;

        // 2. Concurrent-use guard ─────────────────────────────────────────────
        //    If another request is already processing this session, treat it as
        //    a reuse attempt and revoke the session tree immediately.
        if (this.inFlightSessions.has(sessionId)) {
            // Revoke on best-effort basis; ignore errors — session is toast either way.
            await this.repository.revokeSessionAndDescendants(sessionId).catch(() => undefined);
            return null;
        }

        this.inFlightSessions.add(sessionId);

        try {
            // 3. Find session
            const session = await this.repository.findSessionById(sessionId);
            if (!session) {
                return null;
            }

            // 4. Reuse detection: session already explicitly revoked
            if (session.revoked_at) {
                await this.repository.revokeSessionAndDescendants(sessionId);
                return null;
            }

            // 5. Reuse detection: session already has a child (token was used)
            const childSession = await this.repository.findSessionByParentId(sessionId);
            if (childSession) {
                await this.repository.revokeSessionAndDescendants(sessionId);
                return null;
            }

            // 6. Generate new session ID and token pair
            const newSessionId = crypto.randomUUID();
            const tokens = this.tokenService.issueTokens({
                userId,
                sessionId: newSessionId,
                role,
            });

            // 7. Persist new session linked to the current one as parent
            const newTokenHash = this.tokenService.hashToken(tokens.refreshToken);
            const expiresAt = new Date();
            expiresAt.setDate(expiresAt.getDate() + 7); // 7-day refresh window

            await this.repository.createSession({
                id: newSessionId,
                user_id: userId,
                token_hash: newTokenHash,
                expires_at: expiresAt,
                parent_id: sessionId,
            });

            return tokens;
        } finally {
            // Always release the in-flight lock — even if the DB call above fails.
            this.inFlightSessions.delete(sessionId);
        }
    }
}
