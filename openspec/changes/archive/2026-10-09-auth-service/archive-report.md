# Archive Report: Auth Service MVP (Phase 1)

**Date**: 2026-10-09
**Change**: auth-service
**Status**: COMPLETE AND ARCHIVED
**Artifact Store Mode**: hybrid (openspec files + Engram)

## Executive Summary

The auth-service SDD change (Phase 1 MVP, API-only revision) has been implemented, verified, and archived. All units U1-U19 are complete and merged into develop (PRs up to #26). The delta specifications have been merged into the main specification suite under `openspec/specs/`. The change folder has been archived at `openspec/changes/archive/2026-10-09-auth-service/` for the audit trail.

## Change Traceability

All artifacts are recorded with their Engram observation IDs for cross-session recovery:

| Artifact | Observation ID | Type | Source |
|----------|---|---|---|
| Proposal | #586 | architecture | `sdd/auth-service/proposal` |
| Design (ADRs and architecture) | #588 | architecture | `sdd/auth-service/design` |
| Specification (per-capability) | (in openspec/specs/) | N/A | 7 capability specs |
| Tasks and implementation status | (in openspec/changes/archive/) | N/A | tasks.md, design.md |
| Apply Progress (batch reconstructed) | #594 | architecture | `sdd/auth-service/apply-progress` |
| Verify Report (U19 final) | #599 | architecture | `sdd/auth-service/verify-report` |

History observations (archived due to size limits):
- #627: U11a and U2-U7 verify report history
- #629: U13e-U13i hardening verify
- #631: U12, U11c, U11b verify report history
- #632: U13 final verify report
- #634: U14 verify report

## Specifications Synced to Main Suite

All delta specifications from `openspec/changes/auth-service/specs/` have been synced to `openspec/specs/` as the new source of truth:

| Domain | File | Requirements |
|--------|------|---|
| app-registry | `openspec/specs/app-registry/spec.md` | App record, email URLs, operator management, CORS origin binding |
| user-accounts | `openspec/specs/user-accounts/spec.md` | Per-app uniqueness, signup, confirmation, resend, `/me` |
| session-auth | `openspec/specs/session-auth/spec.md` | Login, refresh rotation with grace window, logout, reuse detection |
| abuse-protection | `openspec/specs/abuse-protection/spec.md` | Two-counter lockout, per-IP limits, Postgres storage, client IP derivation |
| token-lifecycle | `openspec/specs/token-lifecycle/spec.md` | RS256 tokens, JWKS publication, key management, no OAuth endpoints |
| password-management | `openspec/specs/password-management/spec.md` | Forgot, reset, change password; all JSON endpoints |
| transactional-email | `openspec/specs/transactional-email/spec.md` | Per-app templates, fragment-based links, provider abstraction |

## Implementation Complete: Units U1-U19

| Unit | PR | Commits | Merged |
|------|----|----|---|
| U1 | #1 | 1a1a1a (bootstrap, Dockerfile, compose) | 2026-09-20 |
| U1b | #2 | container setup | 2026-09-20 |
| U2 | #3 | platform, zod config, health endpoint | 2026-09-21 |
| U3 | #4 | app-registry, origins, CORS | 2026-09-24 |
| U4 | #5 | email outbox, worker, SMTP, templates | 2026-09-27 |
| U5 | #6 | user-accounts, signup, confirm, resend | 2026-09-29 |
| U6 | #7 | token-lifecycle, keys, JWKS, access token issuer | 2026-10-01 |
| U7-U10 | — | SUPERSEDED, never merged | — |
| U11a | #8 | config https, AppUrl, migration | 2026-10-02 |
| U11b | #9 | use cases, CLI, origin binding | 2026-10-02 |
| U11c | #10 | CORS routes, preflight headers | 2026-10-03 |
| U12 | #11 | transactional-email fragment links | 2026-10-03 |
| U13 | #12 | abuse-protection: counters, limiter, sweeper | 2026-10-03 |
| U14 | #13 | session-auth A: sessions, login | 2026-10-05 |
| U15 | #14 | session-auth B: refresh with grace, logout | 2026-10-06 |
| U16 | #15 | AuthenticateBearerUseCase, `/me` | 2026-10-06 |
| U17 | #16 | user-accounts: confirm POST, limits | 2026-10-07 |
| U18 | #17 | password-management: forgot, reset, change | 2026-10-08 |
| U19 | #26 (merge commit 631cb34) | OpenAPI, retention, e2e, ops, smoke test | 2026-10-09 |

All PRs targeted `develop` in stacked order. Each unit is a reviewable, testable, and rollback-safe slice.

## Key Decisions Recorded

Architecture and design decisions (ADRs) are documented in detail in the design artifact (#588):

**Selected highlights**:
- ADR 1: TypeORM + Postgres with `synchronize: false`, migrations with down()
- ADR 2: Hexagonal architecture: domain → application → infrastructure
- ADR 10: bcrypt cost 12 (user-confirmed decision)
- ADR 17: Nodemailer generic SMTP, provider-agnostic
- ADR 21: Testcontainers with real Postgres for tests
- ADR 34: API-only direct credential flow (no hosted login)
- ADR 35: Refresh token families as sessions, 30-day absolute lifetime
- ADR 36: Postgres-backed counters, no Redis
- ADR 38: Origin binding on credential endpoints
- ADR 39: Fragment-based email links pointing to app URLs

## Accepted Open Items

The following items were accepted by the maintainer on 2026-10-09 and are tracked for Phase 2 or follow-up:

### 19.12 Login P95 < 500 ms performance gate (ADR 12)
- **Status**: Not proven on pilot/staging hardware
- **Evidence**: Dev laptop measurements in tasks.md 19.12 show bcrypt cost-12 p95 ~1071 ms in the test container (host timing), so the gate is infrastructure-dependent
- **Decision**: Must be run on pilot/staging hardware; dev laptop is not representative
- **Impact**: Phase 1 deployment can proceed; performance tuning for Phase 2

### 19.11 Browser smoke test (Chrome passed, Firefox/Safari accepted as not run)
- **Evidence**: Chrome 154.0.8037.98 on Windows 11, steps 1-11 passed (obs #643)
- **Decision**: Chrome smoke test complete; Firefox and Safari acceptance documented
- **Impact**: Phase 1 can ship; full cross-browser testing is Phase 2

### Follow-up items from tasks.md
- **F.4**: Decouple platform/http/request-helpers.ts from abuse-protection (design debt)
- **Other follow-ups**: Listed in tasks.md per-unit, mostly refactoring and Phase 2 hardening

### .env.example additions
- **Status**: Documented in `docs/env-example-additions.md`
- **Decision**: Maintainer will paste additions to `.env.example` manually post-merge
- **Impact**: Does not block Phase 1; separate manual step

### Warnings carried forward to Phase 2
- **Jest config maxWorkers 50%**: Configured for slow CI; may benefit from tuning per environment
- **Timing-median e2e test**: May flake on loaded machines; acceptable for Phase 1, recommend isolation or dedicated runner for Phase 2

## Next Phase: Phase 2 Hardening

Phase 2 items from the proposal are ready for scoping:

| Item | Description |
|------|---|
| **Audit logs** | Structured logging of all credential operations |
| **Monitoring and alerts** | Metrics, dashboards, alert rules for abuse, failures |
| **Expired-token cleanup** | Retention job for one-time tokens (in U19, can be optimized) |
| **Outbox cleanup** | Configurable retention for sent/failed emails (in U19) |
| **Apps 2-3** | Register and integrate two additional pilot apps |
| **SDK docs** | Client library guide for login, refresh, token verification |

## Archive Contents

The change folder `openspec/changes/archive/2026-10-09-auth-service/` contains:

- `proposal.md` — Full proposal with intent, scope, risks, rollback plan, and Q&A
- `design.md` — 45 ADRs covering architecture decisions with rationale and tradeoffs
- `specs/` — Delta specification files (7 domains, now in main specs)
  - `app-registry/spec.md`
  - `user-accounts/spec.md`
  - `session-auth/spec.md`
  - `abuse-protection/spec.md`
  - `token-lifecycle/spec.md`
  - `password-management/spec.md`
  - `transactional-email/spec.md`
- `tasks.md` — Task breakdown and verify notes; U1-U6 condensed, U11-U19 detailed
- `archive-report.md` — This file

This archive is an audit trail and is never modified or deleted.

## Verify Report Summary

**U19 Final Verify** (obs #599):
- **Verdict**: READY (0 CRITICAL, 3 WARNING, 4 SUGGESTION)
- **Tests**: 128 suites, 1409 tests passed, 224 s
- **Typecheck**: ✓ (includes `@ts-expect-error` specs)
- **Build**: ✓ (no errors)
- **Git status**: clean, commits conventional
- **Mutation testing**: Key mutations caught (e.g., sessions.expires_at comparison), with 1 flake noted

See full verify report in Engram obs #599 and history observations for per-unit breakdowns.

## Source of Truth Updated

The following specifications are now the canonical source of truth for Phase 1:

- `openspec/specs/app-registry/spec.md`
- `openspec/specs/user-accounts/spec.md`
- `openspec/specs/session-auth/spec.md`
- `openspec/specs/abuse-protection/spec.md`
- `openspec/specs/token-lifecycle/spec.md`
- `openspec/specs/password-management/spec.md`
- `openspec/specs/transactional-email/spec.md`

All specs are current as of 2026-10-09 and reflect the implemented behavior in develop.

## SDD Cycle Complete

The auth-service change has progressed through all SDD phases:

1. **Explore** → Investigated API-only vs OAuth, decided on first-party credential flow
2. **Propose** → Authored proposal with scope, risks, and Phase 2 plan
3. **Spec** → Wrote 7 per-capability specifications with requirements and scenarios
4. **Design** → Documented 45 ADRs covering architecture, data model, and security
5. **Tasks** → Broke down Phase 1 into 19 units (U1-U6 done, U7-U10 superseded, U11-U19 new)
6. **Apply** → Implemented all units in 26 PRs, integrated and merged to develop
7. **Verify** → Validated all tests, typecheck, build, and mutations; 0 CRITICAL issues
8. **Archive** → Moved to archive folder and synced specs to main suite

The change is closed. Next action: Phase 2 scope and planning.
