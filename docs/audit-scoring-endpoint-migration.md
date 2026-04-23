# Multi-Angle Audit Results: gnosis-group Scoring Endpoint Migration

**Date**: 2026-04-07
**Scope**: `src/apps/gnosis-group/logic.ts`, `main.ts`, tests
**Agents**: 7 parallel (Data Integrity, Security, Code Path Consistency, Concurrency, Domain Logic, Architecture, Simplification)

---

## Critical (Must Fix)

_None found._

## High (Should Fix)

| # | Finding | Type | Agents | File:Line | Impact |
|---|---------|------|--------|-----------|--------|
| H1 | HTTP 5xx from scoring service is NOT retried — a 503 during cache rebuild goes straight to error tracker, 3 failures = crash | Bug | Concurrency, Code Path | `logic.ts:842` + `logic.ts:1010-1033` | Transient cache rebuilds could crash the process unnecessarily |
| H2 | Target set drift: server-side `"all_backers"` may diverge from local backers group (different membership, different blacklist filtering) with no detection mechanism | Wrong Assumption | Architecture, Domain Logic | `logic.ts:835` | Scores computed against wrong population → incorrect trust/untrust decisions |
| H3 | README still documents old batch URL (`squid-app-3gxnl...batch`), missing new `GNOSIS_GROUP_SCORING_TARGET_SET_NAME` env var | Missing Dependency | Code Path, Architecture | `README.md:242` | Operators copying README examples get wrong URL and miss config |

## Medium (Should Fix)

| # | Finding | Type | Agents | File:Line | Impact |
|---|---------|------|--------|-----------|--------|
| M1 | Response body not consumed on HTTP error — risks connection pool exhaustion under sustained errors | Bug | Concurrency | `logic.ts:842-843` | TCP sockets held until GC under error conditions |
| M2 | 90s timeout over-generous for cache-hit endpoint (typical response ~200ms) | Design Flaw | Concurrency | `logic.ts:109` | Slow/hung endpoint blocks run for up to 270s (3 retries) before failing |
| M3 | `Dockerfile` uses `node:latest` — no pinned version, no slim variant | Security | Security | `Dockerfile:1` | Non-reproducible builds, larger attack surface (pre-existing) |
| M4 | No test for `include_details: false` in request body | Missing Dependency | Data Integrity, Domain Logic | tests | Future refactor could silently change request contract |
| M5 | No test for custom `scoringTargetSetName` override flowing through to HTTP body | Missing Dependency | Domain Logic | tests | Config override untested |

## Low (Nice to Fix)

| # | Finding | Type | Agents | File:Line | Impact |
|---|---------|------|--------|-----------|--------|
| L1 | `trustedTargets` variable name is vestigial — no longer sent to scoring, only guards backers group emptiness | Redundant System | Simplification, Code Path, Architecture | `logic.ts:266-269` | Misleading name for future maintainers |
| L2 | `RunOutcome.trustedTargetCount` — populated but never consumed by any caller or test | Redundant System | Simplification | `logic.ts:48, 576` | Dead output field |
| L3 | `RelativeTrustScoreEntry` has 3 unused optional fields (`targets_reached`, `total_targets`, `penetration_rate`) | Redundant System | Simplification | `logic.ts:7-13` | Dead type declarations |
| L4 | Retry pattern duplicated 3x (scoring, blacklist, batch ops) — extract shared helper | Simplification | Simplification | `logic.ts:792-944` | Duplication across retry wrappers |
| L5 | ScoreCache grows without bound (no eviction of expired entries) | Bug | Security | `logic.ts:68-89` | Slow memory growth over long uptime (pre-existing) |
| L6 | `DEFAULT_SCORE_CACHE_TTL_MS` divided by 60_000 in env parsing — fragile naming | Design Flaw | Data Integrity | `main.ts:58` | Confusing if constant unit ever changes |
| L7 | No `target_set_name` format validation at startup | Security | Security | `main.ts:59` | Defense-in-depth gap for env var |
| L8 | Addresses sent to scoring service are not normalized (checksummed) | Design Flaw | Data Integrity | `logic.ts:314-335` | Depends on external service tolerating mixed-case |
| L9 | Unbounded response body parsing — no max size before `.json()` | Security | Security | `logic.ts:846` | OOM if scoring service returns huge payload |
| L10 | 4h local cache + 5min server cache = compounding staleness not documented | Design Flaw | Domain Logic, Architecture | `logic.ts:66` | Scores up to ~4h5min stale; untrust decisions delayed |

---

## Cross-Agent Confirmations

These issues were independently flagged by multiple agents, giving higher confidence:

| Finding | Agents that flagged it |
|---------|----------------------|
| **H2** Target set drift (server vs local) | Architecture, Domain Logic, Data Integrity |
| **H3** README stale / missing env var docs | Code Path, Architecture |
| **H1** HTTP 5xx not retried | Concurrency, Code Path |
| **L1** `trustedTargets` vestigial naming | Simplification, Code Path, Architecture |
| **L2** `trustedTargetCount` dead field | Simplification, Domain Logic |

---

## Recommended Fix Order

### Immediate (before deploy)
1. **H1** — Make HTTP 5xx retryable: check `response.status >= 500` before throwing, add recognizable error property so `isRetryableFetchError` catches it
2. **H3** — Update README with new scoring URL and `GNOSIS_GROUP_SCORING_TARGET_SET_NAME` env var
3. **M1** — Consume response body on error: `void response.body?.cancel()` before throw

### Soon (this PR or follow-up)
4. **M2** — Reduce default timeout to 15-20s (or document env var override for operators)
5. **M4/M5** — Add test assertions for `include_details: false` and custom `targetSetName`
6. **H2** — Add reconciliation guard: compare local backers count vs `total_targets` from a probe request with `include_details: true`

### Backlog
7. **L1/L2** — Rename `trustedTargets` → `backersGroupTrustees`, remove/rename `trustedTargetCount`
8. **L4** — Extract shared retry helper
9. **L5** — Add cache eviction for expired entries
10. **L10** — Document the cache stacking behavior

---

## Positive Observations (all agents)

- Response type migration is clean — no old batch-format assumptions leak through
- Address normalization via `ethers.getAddress()` is consistent at all trust decision points
- `AbortController` cleanup is correct in all paths (`finally` block)
- Leader election heartbeat runs independently — unaffected by scoring call duration
- Dry-run vs live paths are consistent for scoring calls
- All test mocks updated consistently from batch to flat format
- Configuration follows existing patterns throughout
