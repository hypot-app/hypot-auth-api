# Abuse Protection Specification

## Purpose

Postgres-backed rate limiting and temporary lockout for the credential endpoints, so brute force, credential stuffing, email bombing and bcrypt CPU exhaustion stay cheap to absorb. No Redis. Alerts, dashboards and audit logs are Phase 2.

## Requirements

### Requirement: Two-counter login lockout

The system MUST count login attempts with two counters, following NIST SP 800-63B and avoiding targeted-lockout DoS:

| Counter | Key | Default | Effect |
|---------|-----|---------|--------|
| Pair | (app, account, client IP) | 5 attempts / 15 min | The 6th and later attempts are blocked; that IP is blocked from that account for 15 min |
| Global | (app, account) | 50 attempts / 1 h from any IP | The 51st and later attempts are blocked; the account is locked for 15 min |

Every threshold, window and block duration MUST be configurable by environment settings with these defaults. Counters MUST also be kept for unknown emails (keyed by email hash), so lockout cannot reveal whether an account exists. While blocked or locked, even the correct password MUST fail, and attempts made during a block MUST NOT extend it. The same counters apply to `POST /password/change`: a wrong current password is a failed login for both counters, and while the (account, IP) pair is blocked or the account is locked, change MUST fail with the same `invalid_current_password` error even for the correct password, without running bcrypt. An attempt MUST be counted atomically BEFORE the password is checked, so parallel attempts cannot all pass a check made before any of them is counted. A successful login MUST reset the pair counter and MUST NOT reset or decrement the global counter (assumption: the global counter counts attempts rather than failures, because a decrement would reopen the race; successes are rare against the limit).

#### Scenario: Pair block
- GIVEN IP X made 5 login attempts for account U in 15 minutes
- WHEN IP X tries U again, even with the correct password
- THEN the generic login failure is returned
- AND IP Y can still log in to U with the correct password

#### Scenario: Parallel attempts
- GIVEN 12 simultaneous login attempts for account U from IP X
- THEN exactly 5 are allowed to check the password
- AND the other 7 get the generic login failure without running bcrypt

#### Scenario: Global lock
- GIVEN 50 login attempts against U in 1 hour from many IPs
- WHEN any IP logs in to U with the correct password
- THEN the generic login failure is returned until the 15 min lock ends

#### Scenario: Lock expires
- GIVEN U was locked 15 minutes ago
- WHEN the correct password is submitted
- THEN login succeeds

#### Scenario: Unknown email behaves the same
- GIVEN an email with no account
- WHEN one IP fails 5 times and then tries again
- THEN the response is identical to a blocked real account

#### Scenario: Thresholds configurable
- GIVEN the pair threshold is configured as 3
- WHEN IP X fails 3 times
- THEN IP X is blocked for that account

### Requirement: Per-IP rate limits

The system MUST apply a per-client-IP rate limit to each of: login, signup, resend-confirmation, forgot-password, reset, refresh and confirm. Each limit and window MUST be configurable, and the defaults MUST be documented in the design (ADR 36). Refresh and confirm are token-guessing surfaces; they are limited per IP only, and the check MUST run before any token lookup. `GET /me` and logout have no limiter: bearer verification is a local signature check with no database access, and logout is idempotent. Email-sending endpoints (signup, resend-confirmation, forgot-password) MUST also be limited per target account (assumption: 3 per hour), to stop email bombing from many IPs. Every email a forgot-password request sends counts toward that cap, whether it is a reset email or a confirmation email for an unconfirmed account.

#### Scenario: Login IP limit
- GIVEN an IP exceeded the login limit
- WHEN it posts another login
- THEN the generic login failure is returned (never 429) without running bcrypt

#### Scenario: Per-account email cap
- GIVEN 3 forgot-password requests for the same account in an hour
- WHEN a 4th arrives from a new IP
- THEN the generic 202 is returned
- AND no email is sent

### Requirement: Limited response on non-login endpoints

When a per-IP limit is hit on signup, resend-confirmation, forgot-password, reset, refresh or confirm, the system MUST return 429 with a `Retry-After` header (an integer number of seconds until the window ends) and the generic body `{ "error": "rate_limited", "message": "Too many requests. Try again later." }`. The decision MUST depend only on the caller's IP and the endpoint, never on account state, so it cannot enumerate accounts. Per-account caps MUST NOT produce 429; they silently suppress the email and return the normal generic response. Login MUST NOT return 429 (it returns the generic login failure).

#### Scenario: Signup flood
- GIVEN an IP exceeded the signup limit
- WHEN it posts a signup for a new or an existing email
- THEN the response is 429 with `Retry-After`, identical for both

#### Scenario: Refresh flood
- GIVEN an IP exceeded the refresh limit
- WHEN it posts refresh with a valid or an invalid token
- THEN the response is 429 with an integer `Retry-After`, identical for both
- AND no token is looked up or consumed

#### Scenario: Confirm flood
- GIVEN an IP exceeded the confirm limit
- WHEN it posts confirm with a valid or an invalid token
- THEN the response is 429 with an integer `Retry-After`, identical for both
- AND no token is looked up or consumed

#### Scenario: Forgot for an unconfirmed account counts toward the cap
- GIVEN 3 emails were sent for an unconfirmed account in an hour (confirmation emails from signup, resend or forgot)
- WHEN a forgot-password request for it arrives
- THEN the generic 202 is returned
- AND no email is sent

### Requirement: Client IP derivation

The system MUST derive the client IP from the TCP peer address by default. `X-Forwarded-For` MUST be honored only when the peer is listed in a configured trusted-proxy setting (`TRUST_PROXY`: hop count or CIDR list, default none; `true` is rejected). When honored, the system MUST walk the header from right to left, skipping trusted proxies, and take the first untrusted address. Malformed entries MUST fall back to the peer address. The leftmost header value MUST NEVER be trusted directly.

#### Scenario: Spoofed header, no proxy configured
- GIVEN `TRUST_PROXY` is unset
- WHEN a client sends `X-Forwarded-For: 1.2.3.4`
- THEN the limiter keys on the TCP peer address

#### Scenario: Spoofed header behind a trusted proxy
- GIVEN the load balancer is trusted and appends the real peer
- WHEN a client sends `X-Forwarded-For: 1.2.3.4` and the proxy yields `1.2.3.4, 203.0.113.9`
- THEN the client IP is `203.0.113.9`

### Requirement: Postgres storage

Counters MUST live in Postgres with atomic increments and expiry, with no Redis. Stored keys for accounts MUST be hashes of the normalized email, and stale rows MUST be purgeable. If the store is unavailable, credential endpoints MUST fail closed with a 503 (assumption).

#### Scenario: Concurrent failures
- GIVEN 10 simultaneous failed logins from one IP
- WHEN they complete
- THEN the pair counter reads 10, not fewer
