# Rate Limiter Tier Policies

## Overview
Revora-Backend implements a multi-tier rate limiting policy for sensitive endpoints, such as startup registration. This ensures production-grade availability while providing flexibility for trusted partners and internal services.

## Tiers and Limits

| Tier | Request Limit | Window | Description |
| :--- | :--- | :--- | :--- |
| **Standard** | 5 | 15 minutes | Default for public IP addresses. |
| **Trusted** | 10 | 15 minutes | For verified external partners. |
| **Internal** | 25 | 15 minutes | For Revora's internal infrastructure and management tools. |

## Security Assumptions

1.  **Identity Assertion**: Tier resolution is performed via custom headers (`x-revora-rate-tier`).
2.  **Shared Secret**: Privileged tiers (`trusted`, `internal`) require a valid shared secret passed in the `x-revora-tier-secret` header.
3.  **Default to Safe**: If no tier is specified, or if the provided secret is invalid/missing, the system defaults to the **Standard** tier.
4.  **IP-Based Tracking**: Rate limits are tracked per IP address to prevent brute-force attacks from a single source.
5.  **In-Memory Storage**: Current implementation uses an in-memory store. In multi-instance deployments, this should be replaced with a distributed store (e.g., Redis).

## Usage

### Headers

-   `x-revora-rate-tier`: The requested tier (`standard`, `trusted`, `internal`).
-   `x-revora-tier-secret`: The shared secret required for privileged tiers.

### Response Headers

Standard X-RateLimit headers are returned:
-   `X-RateLimit-Limit`: The total number of requests allowed in the window.
-   `X-RateLimit-Remaining`: The number of requests remaining in the current window.
-   `X-RateLimit-Reset`: The UTC epoch seconds when the window resets.

When the limit is exceeded, a `429 Too Many Requests` status is returned with a `Retry-After` header indicating the number of seconds to wait.

## Enforcement

The policy is enforced via the `createStartupAuthTierLimiter` middleware, which is mounted on the `/api/v1/startup/register` endpoint.
