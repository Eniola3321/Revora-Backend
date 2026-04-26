import crypto from 'node:crypto';
import { Pool } from 'pg';
import { withTransaction } from '../../db/transaction';
import { Logger } from '../../lib/logger';
import {
    RefreshSuccessResponse,
    RefreshTokenRepository,
    TokenService,
} from './types';

export class RefreshService {
    constructor(
        private readonly repository: RefreshTokenRepository,
        private readonly tokenService: TokenService,
        private readonly db: Pool,
        private readonly logger: Logger = new Logger(),
    ) {}

    /**
     * Rotate a refresh token with concurrent refresh protection.
     * Uses database transactions to prevent race conditions where
     * multiple simultaneous refresh requests could bypass reuse detection.
     */
    async refresh(token: string): Promise<RefreshSuccessResponse | null> {
        // 1. Verify token (outside transaction - stateless)
        let payload;
        try {
            payload = this.tokenService.verifyRefreshToken(token);
        } catch (error) {
            this.logger.warn('Refresh token verification failed', {
                error: error instanceof Error ? error.message : String(error),
                tokenPrefix: token.substring(0, 10) + '...',
            });
            return null;
        }

        const { sessionId, userId, role } = payload;

        this.logger.info('Processing refresh request', {
            userId,
            sessionId,
            role,
        });

        // 2. Execute refresh logic within transaction for atomicity
        return withTransaction(this.db, async (client) => {
            // 2a. Find and lock parent session for update (prevents concurrent refresh)
            const session = await this.repository.findSessionByIdForUpdate(sessionId, client);
            if (!session) {
                this.logger.warn('Session not found during refresh', {
                    userId,
                    sessionId,
                });
                return null;
            }

            // 2b. Validate token hash matches what's stored (prevents replay attacks)
            const incomingTokenHash = this.tokenService.hashToken(token);
            if (session.token_hash !== incomingTokenHash) {
                this.logger.warn('Token hash mismatch during refresh', {
                    userId,
                    sessionId,
                    storedHash: session.token_hash.substring(0, 10) + '...',
                    incomingHash: incomingTokenHash.substring(0, 10) + '...',
                });
                // Token hash mismatch - revoke the session family
                await this.repository.revokeSessionAndDescendants(sessionId, client);
                return null;
            }

            // 2c. Check if session is already revoked
            if (session.revoked_at) {
                this.logger.warn('Attempted refresh on revoked session', {
                    userId,
                    sessionId,
                    revokedAt: session.revoked_at,
                });
                await this.repository.revokeSessionAndDescendants(sessionId, client);
                return null;
            }

            // 2d. Check for reuse detection: if this session already has a child
            const childSession = await this.repository.findSessionByParentId(sessionId, client);
            if (childSession) {
                this.logger.warn('Token reuse detected during refresh', {
                    userId,
                    sessionId,
                    childSessionId: childSession.id,
                });
                await this.repository.revokeSessionAndDescendants(sessionId, client);
                return null;
            }

            // 2d. Generate new session ID and tokens
            const newSessionId = crypto.randomUUID();
            const tokens = this.tokenService.issueTokens({
                userId,
                sessionId: newSessionId,
                role,
            });

            // 2e. Create new session for the new refresh token
            const newTokenHash = this.tokenService.hashToken(tokens.refreshToken);
            const expiresAt = new Date();
            expiresAt.setDate(expiresAt.getDate() + 7); // 7 days

            await this.repository.createSession({
                id: newSessionId,
                user_id: userId,
                token_hash: newTokenHash,
                expires_at: expiresAt,
                parent_id: sessionId,
            }, client);

            this.logger.info('Refresh token rotated successfully', {
                userId,
                oldSessionId: sessionId,
                newSessionId,
                role,
            });

            return tokens;
        }).catch((error) => {
            this.logger.error('Refresh transaction failed', {
                userId,
                sessionId,
                error: error instanceof Error ? error.message : String(error),
            });
            throw error;
        });
    }
}
