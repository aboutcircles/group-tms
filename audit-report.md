# Multi-Angle Audit Results: group-tms (rpc-429-staging)

**Date:** 2026-03-31
**Agents:** 6 (Data Integrity, Security, Code Path Consistency, Concurrency, Domain Logic, Architecture)
**Scope:** All changed files in staging+dev merge + full service/app layer review

---

## Critical (Must Fix)

| # | Finding | Type | Agent(s) | File:Line | Impact |
|---|---------|------|----------|-----------|--------|
| 1 | `fetchEventsRecursive` silently drops events at MAX_DEPTH (10). When depth cap fires with a full 100-event page, remaining events are permanently lost — no log, no metric, no error. `crc-backers` advances the block cursor past them. | Bug | Data#4, Path#1, Arch#5 | `circlesRpcService.ts:297` | **Permanently missed backing events** — backers complete but never get trusted |
| 2 | All 5 pagination loops silently truncate at MAX_PAGES (500) with no warning. Callers receive partial results indistinguishable from complete ones. As Circles grows, `fetchAllHumanAvatars` will hit this ceiling. | Bug | Data#4, Path#2, Arch#1 | `circlesRpcService.ts:69,143,202,389,416` | **Silent data loss** — humans/groups/trustees silently excluded from trust operations |

## High (Should Fix)

| # | Finding | Type | Agent(s) | File:Line | Impact |
|---|---------|------|----------|-----------|--------|
| 3 | `BlacklistingService.checkBlacklist()` returns `{is_bot: false}` when blacklist not loaded — **fails open**. A skipped `loadBlacklist()` silently allows all addresses. | Security | Security H-2 | `blacklistingService.ts:74-81` | Blacklisted addresses trusted into groups |
| 4 | `router-tms` calls `checkBlacklist` with no retry, unlike gp-crc/gnosis-group which have `fetchBlacklistVerdictsWithRetry` with 3 attempts. | Security | Security H-3 | `router-tms/logic.ts:233` | Transient blacklist failure → entire run fails |
| 5 | `gnosis-group` ScoreCache has no eviction — `Map<string, {score, fetchedAt}>` grows unbounded. Every scored avatar cached indefinitely. | Security | Security H-1 | `gnosis-group/logic.ts:66-87` | OOM over time as Circles membership grows |
| 6 | `waitForTransaction` listener leaks on timeout. Ethers installs a block listener that is never cancelled when `Promise.race` resolves via timeout. Repeated timeouts accumulate listeners. | Bug | Concurrency#6 | `safeTransactionExecutor.ts:87-95` | MaxListenersExceededWarning, resource leak |
| 7 | `isTransientRpcError` uses substring matching for "429" — `"block 42900001 not found"` would be misclassified as transient. No structured HTTP status code check. | Wrong Assumption | Data#7, Arch#3 | `retryWithBackoff.ts:13,19-25` | False positive retries on permanent errors containing "429" |
| 8 | `safePromise` permanently caches a rejected `Safe.init()`. A brief RPC hiccup at startup poisons the executor for the process lifetime — every subsequent call immediately throws. | Bug | Concurrency#5 | `safeTransactionExecutor.ts:47-51` | Permanent executor failure until container restart |
| 9 | crc-backers: `OrderNotYetFilled` past-deadline path uses `break` (misleading "fall through" comment), then falls into the pre-deadline reset path — semantically wrong for expired orders. | Bug | Domain#4.1 | `crc-backers/logic.ts:468-486` | Expired unfilled orders get incorrect reset attempt |

## Medium (Nice to Fix)

| # | Finding | Type | Agent(s) | File:Line | Impact |
|---|---------|------|----------|-----------|--------|
| 10 | `mapEvents` uses `parseInt(hex, 16)` with no `Number.isFinite` guard — malformed RPC response produces `NaN` blockNumber that propagates silently through sort and downstream logic. | Bug | Data#3, Security L-3 | `circlesRpcService.ts:273-283` | Silent NaN propagation if RPC returns malformed hex |
| 11 | Address normalization divergence: app-level `normalizeAddress` in gp-crc/gnosis-group returns checksum (EIP-55), while `circlesRpcService` returns lowercase. Comparison works today via explicit `.toLowerCase()` calls, but fragile. | Design Flaw | Data#1,#2, Domain#9.1 | `gp-crc/logic.ts:381`, `gnosis-group/logic.ts:1002` | Future address mismatch bugs from copy-paste |
| 12 | OIC affiliate events sorted by `blockNumber` only, not `(blockNumber, transactionIndex, logIndex)`. Two events in same block have non-deterministic order. | Bug | Domain#8.2 | `oic/logic.ts:317-319` | Affiliate group state depends on log ordering |
| 13 | Exception handler Slack notification has no timeout. If Slack API hangs, `process.exit(1)` never fires. | Bug | Security M-7, Concurrency#11 | All `main.ts` files | Process hangs instead of crashing on fatal error |
| 14 | `router-tms` dry-run skips `markEnabled` persistence. On leader election handoff (dry→live), the now-live node re-issues `enableCRCForRouting` for every avatar. Idempotent but wasteful. | Design Flaw | Path#10 | `router-tms/logic.ts:183-205` | Burst of unnecessary on-chain txs on failover |
| 15 | Blacklisted-but-completed backers appear as "pending" every run because `completedKeys` excludes blacklisted. Reconcile loop may re-process already-completed instances. | Bug | Domain#4.2 | `crc-backers/logic.ts:273` | Wasted RPC calls and Slack noise for blacklisted backers |
| 16 | `execute()` vs `simulate()` semantic gap undocumented. `simulate()` pre-validates callability via `provider.call()`; `execute()` does not. | Missing Dependency | Path#3 | `safeTransactionExecutor.ts:75,120` | Operators may assume simulate pass = execute success |
| 17 | `withTimeout` can't cancel the underlying RPC request — only stops waiting. Ghost requests continue consuming RPC resources and rate-limit budget. | Design Flaw | Arch#4 | `circlesRpcService.ts:16-26` | Timed-out requests still hit RPC, counterproductive under 429 |
| 18 | Retry backoff has no jitter. Multiple containers restarting simultaneously retry at identical intervals → thundering herd. | Design Flaw | Security L-1 | `retryWithBackoff.ts:53` | Coordinated retry storms after deployment |
| 19 | 6 `main.ts` files with ~80% duplicated polling infrastructure. Every cross-cutting change requires 6 parallel edits. Inconsistencies already exist (gnosis-group subtracts elapsed, others don't). | Redundant System | Arch#2 | All `main.ts` | Maintenance burden, divergent operational behavior |
| 20 | `previouslyEnabled` store in router-tms grows monotonically. Externally removed router trust is never recovered by the app. | Design Flaw | Domain#5.1 | `router-tms/logic.ts:98,124-125` | Externally untrusted avatars never re-enabled |

## Low (Minor)

| # | Finding | Type | Agent(s) | File:Line | Impact |
|---|---------|------|----------|-----------|--------|
| 21 | `GroupService` receipt check `!== 1` (number only) vs `SafeTransactionExecutor` three-form check (`!== 1 && !== 1n && !== "0x1"`) | Bug | Path#4 | `groupService.ts:50` | Could misinterpret BigInt status in future ethers |
| 22 | Leader election heartbeat can overlap if PG query takes >15s. Duplicate Slack notifications possible. | Bug | Concurrency#8 | `leaderElection.ts:55` | Duplicate status notifications |
| 23 | `timer!` non-null assertion on uninitialized `let` in `withTimeout` | Bug | Concurrency#1 | `circlesRpcService.ts:17,24` | Code smell, correct in practice |
| 24 | `lastBulkTrusteesForTrustersStats` shared mutable state — latent race if batches ever parallelized | Design Flaw | Concurrency#4, Arch#9 | `circlesRpcService.ts:35-38` | Wrong stats if concurrent callers |
| 25 | `ALWAYS_TRUSTED_ADDRESSES` in OIC bypasses blacklist. No mechanism to revoke without code deploy. | Security | Domain#8.1 | `oic/logic.ts:7-35` | Compromised hardcoded address stays trusted |
| 26 | Score threshold is strict `>` not `>=`. Score == 100 excluded from trust. Verify against product intent. | Wrong Assumption | Domain#7.1 | `gnosis-group/logic.ts:358,607` | Boundary avatars may be excluded unintentionally |
| 27 | `FallbackProvider` broadcasts to all URLs simultaneously, doubling RPC request rate under 429 pressure. | Design Flaw | Concurrency#14 | `rpcProvider.ts:32-35` | Counterproductive under rate limiting |
| 28 | Error messages sent to Slack may contain connection strings or RPC URLs with API keys. | Security | Security M-4 | All `main.ts` | Information leakage to third-party webhook |

---

## Cross-Agent Confirmations

Issues found by 3+ agents (highest confidence):

1. **Silent truncation at MAX_PAGES/MAX_DEPTH** (#1, #2) — flagged by Data Integrity, Code Path, Architecture agents
2. **Address normalization inconsistency** (#11) — flagged by Data Integrity, Domain Logic agents
3. **429 string matching fragility** (#7) — flagged by Data Integrity, Architecture agents

Issues found by 2 agents:

4. **Slack webhook timeout missing** (#13) — Security + Concurrency
5. **parseInt NaN propagation** (#10) — Data Integrity + Security
6. **Shared mutable stats state** (#24) — Concurrency + Architecture

---

## Recommended Fix Order

### Immediate (this PR or next)
1. **#1 + #2**: Add `logger.warn` when MAX_PAGES or MAX_DEPTH cap is hit with a full result page. Add Prometheus counter `rpc_pagination_capped_total`. This is 10 lines of code and prevents silent data loss.
2. **#7**: Change `"429"` in TRANSIENT_MESSAGES to a regex `/\b429\b/` or add `429` to `TRANSIENT_CODES` as a numeric check. Prevents false positive matching.
3. **#10**: Add `Number.isFinite()` guard in `mapEvents` after `parseInt`. Skip or warn on malformed events.

### Soon (next sprint)
4. **#3**: Make `checkBlacklist()` throw when `loaded === false` (fail-closed)
5. **#4**: Add retry wrapper to router-tms blacklist call, matching gp-crc/gnosis-group pattern
6. **#5**: Add LRU eviction or periodic sweep to ScoreCache
7. **#8**: Lazy-init pattern for `safePromise` (reinitialize on failure)
8. **#9**: Fix `OrderNotYetFilled` past-deadline path to skip reset and continue
9. **#13**: Add AbortController timeout to Slack webhook calls in exception handlers

### Later (tech debt)
10. **#6**: Cancel `waitForTransaction` listener on timeout (ethers-specific)
11. **#12**: Add `transactionIndex`/`logIndex` to OIC `AffiliateGroupChanged` type and sort by full ordering
12. **#18**: Add jitter to `retryWithBackoff`
13. **#19**: Extract shared `WorkerLoop` from the 6 main.ts files
14. **#11**: Standardize all `normalizeAddress` functions to return lowercase
