# Circles Group Trust Management Service

Specialized services for Circles protocol trust management:

## CRC Backers App
* Scans Circles **BackingCompleted**/**BackingInitiated** events
* Filters out blacklisted backers
* **Trusts** valid new backers into a group in batches of 50
* Reconciles initiated-but-not-completed processes (resets CowSwap order or creates LBP)
* Optionally notifies Slack when something looks stuck
* Runs once a minute
* Supports dry-run mode to exercise the logic without submitting Safe transactions

## GP CRC App
* Scans Circles **RegisterHuman** events for newly registered avatars
* Cross-checks avatars against the blacklist service and Metri Safe GraphQL data
* Trusts eligible avatars into the configured group in batches (default 10)
* Supports dry-run mode and Slack notifications
* Runs every 10 minutes

## Dublin TMS App
* Scans on-chain **RegisterHuman** logs from the configured contract
* Filters events where `originInviter` is one of a configured allowlist
* Trusts the matching `human` avatars into a configured group
* Supports chunked block scanning, dry-run mode, and Slack notifications
* Runs continuously with configurable poll interval

## OIC App  
* Monitors affiliate group changes and trust relationships
* Reconciles trust between MetaOrg trustees and affiliates
* Supports dry-run mode for testing
* Incremental scanning with configurable refresh intervals
* Batch processing for efficient trust operations

## Requirements

* Node.js **≥ 24**
* A Circles RPC endpoint (e.g. https://rpc.aboutcircles.com/)
* A private key that is the **group service** for the backers group

## Quick start

### Local Development

```bash
# 1) Install
npm install

# 2) Configure
touch .env   # Check the values below and fill in your .env file

# 3) Run

# Option A: build then run with .env
npx tsc && node --env-file=.env dist/src/main.js

# Option B: use scripts (also load .env)
npm run start:crc-backers
npm run start:gp-crc
npm run start:dublin-tms
npm run start:oic
npm run start:all
```

## Configuration (.env)

### CRC Backers App Configuration

```dotenv
# RPC & addresses
RPC_URL=https://rpc.aboutcircles.com/
BACKING_FACTORY_ADDRESS=0xeced91232c609a42f6016860e8223b8aecaa7bd0
BACKERS_GROUP_ADDRESS=0x1ACA75e38263c79d9D4F10dF0635cc6FCfe6F026

# Safe execution
CRC_BACKERS_SAFE_ADDRESS=                # Safe set as the group's service
CRC_BACKERS_SAFE_SIGNER_PRIVATE_KEY=     # Private key for one Safe signer

# Blacklist service
BLACKLISTING_SERVICE_URL=https://squid-app-3gxnl.ondigitalocean.app/aboutcircles-advanced-analytics2/bot-analytics/classify

# Scan window / timing
START_AT_BLOCK=39743285
CONFIRMATION_BLOCKS=2
EXPECTED_SECONDS_TILL_COMPLETION=60

# Notifications
SLACK_WEBHOOK_URL=

# Logging
VERBOSE_LOGGING=1     # any truthy value enables debug/table

# Operation mode
DRY_RUN=0             # Set to "1" to skip Safe transactions and only log actions
```

### GP CRC App Configuration

```dotenv
# RPC & addresses
RPC_URL=https://rpc.aboutcircles.com/
GP_CRC_GROUP_ADDRESS=0xb629a1e86f3efada0f87c83494da8cc34c3f84ef

# Safe execution (required unless dry run)
GP_CRC_SAFE_ADDRESS=                     # Safe that controls the group's service role
GP_CRC_SAFE_SIGNER_PRIVATE_KEY=          # Private key for a Safe signer

# Metri Safe GraphQL
METRI_SAFE_GRAPHQL_URL=https://gnosis-e702590.dedicated.hyperindex.xyz/v1/graphql
METRI_SAFE_API_KEY=                      

# Blacklist service
BLACKLISTING_SERVICE_URL=https://squid-app-3gxnl.ondigitalocean.app/aboutcircles-advanced-analytics2/bot-analytics/classify

# Scan window / timing
START_AT_BLOCK=31734312
CONFIRMATION_BLOCKS=10
DRY_RUN=0                                 # Set to "1" to skip transactions

# Notifications
SLACK_WEBHOOK_URL=

# Logging
VERBOSE_LOGGING=1
```

### OIC App Configuration

```dotenv
# RPC & addresses
RPC_URL=https://rpc.aboutcircles.com/
OIC_GROUP_ADDRESS=0x4E2564e5df6C1Fb10C1A018538de36E4D5844DE5
OIC_META_ORG_ADDRESS=                    # REQUIRED - Meta organization address
AFFILIATE_REGISTRY_ADDRESS=0xca8222e780d046707083f51377b5fd85e2866014

# EOA execution (required unless dry run)
OIC_SERVICE_EOA=                         # Optional: expected service EOA address for key validation
OIC_SERVICE_PRIVATE_KEY=                 # Private key for the group service EOA

# Scan window / timing
# Start block is hardcoded in OIC code to 41734312
CONFIRMATION_BLOCKS=10
REFRESH_INTERVAL_SEC=60

# Operation mode
DRY_RUN=0                               # Set to "1" for dry run mode (no actual transactions)

# Notifications
SLACK_WEBHOOK_URL=

# Logging
VERBOSE_LOGGING=1     # any truthy value enables debug/table
```

### Dublin TMS App Configuration

```dotenv
# RPC
RPC_URL=https://rpc.aboutcircles.com/

# RegisterHuman source + target group
DUBLIN_TMS_ADDRESS=0xAeCda439CC8Ac2a2da32bE871E0C2D7155350f80

# Scan window / timing
DUBLIN_TMS_START_BLOCK=44560106
DUBLIN_TMS_TO_BLOCK=             # optional; if unset follows head-confirmations
DUBLIN_TMS_CHUNK_SIZE=2000
DUBLIN_TMS_CONFIRMATION_BLOCKS=2
DUBLIN_TMS_POLL_INTERVAL_MS=600000
DUBLIN_TMS_BATCH_SIZE=50

# EOA execution (required unless dry run)
DUBLIN_TMS_SERVICE_EOA=0x20a3C619De4C15E360d30F329DBCfe5bb618654f
DUBLIN_TMS_SERVICE_PRIVATE_KEY=

# Operation mode
DRY_RUN=0

# Notifications
DUBLIN_TMS_SLACK_WEBHOOK_URL=    # optional override; falls back to SLACK_WEBHOOK_URL
SLACK_WEBHOOK_URL=

# Logging
VERBOSE_LOGGING=1
```

### Router TMS Configuration

```dotenv
# RPC & addresses
RPC_URL=https://rpc.aboutcircles.com/
ROUTER_ADDRESS=0xdc287474114cc0551a81ddc2eb51783fbf34802f
ROUTER_BASE_GROUP_ADDRESS=0x1ACA75e38263c79d9D4F10dF0635cc6FCfe6F026

# Safe execution (required unless dry run)
ROUTER_SAFE_ADDRESS=                       # Safe that controls the router's trusted executor
ROUTER_SAFE_SIGNER_PRIVATE_KEY=            # Private key for one Safe signer

# Scan window / timing
ROUTER_POLL_INTERVAL_MS=1800000
ROUTER_ENABLE_BATCH_SIZE=50
ROUTER_FETCH_PAGE_SIZE=2000
ROUTER_BLACKLIST_CHUNK_SIZE=1000

# Operation mode
DRY_RUN=0                                  # Set to "1" to log actions without enabling routing

# Notifications
SLACK_WEBHOOK_URL=

# Logging
VERBOSE_LOGGING=1
```

### Gnosis Group App Configuration

```dotenv
# RPC & addresses
RPC_URL=https://rpc.aboutcircles.com/

# Safe execution
GNOSIS_GROUP_SAFE_ADDRESS=                # Safe that owns the group service role
GNOSIS_GROUP_SAFE_SIGNER_PRIVATE_KEY=     # Private key of a 1/n Safe signer 

# External services
BLACKLISTING_SERVICE_URL=https://squid-app-3gxnl.ondigitalocean.app/aboutcircles-advanced-analytics2/bot-analytics/classify
GNOSIS_GROUP_SCORING_URL=https://squid-app-3gxnl.ondigitalocean.app/aboutcircles-advanced-analytics2/scoring/relative_trustscore/batch

# Operation mode
GNOSIS_GROUP_DRY_RUN=0                 # Set to "1" to skip blacklist & scoring requests

# Notifications
GNOSIS_GROUP_SLACK_WEBHOOK_URL=        # Optional override; falls back to SLACK_WEBHOOK_URL
SLACK_WEBHOOK_URL=

# Logging
VERBOSE_LOGGING=1
```

## What each app does

### CRC Backers App

* Uses a reorg buffer (`CONFIRMATION_BLOCKS`) from chain head
 * From `START_AT_BLOCK` → head:
   * Pulls **BackingCompleted**, filters via blacklist service, dedupes already-trusted backers, and calls
     `trustBatchWithConditions(group, addresses, expiry=max uint96)` in batches of 50
   * Finds **BackingInitiated** without matching completion:
       * If **past deadline** (initiated timestamp + 24h): try `createLBP()`; notify Slack on inconsistent/insufficient states
       * If **before deadline**: try `resetCowswapOrder()` when valid; if already settled, attempt LBP creation
* Logs summaries by default; `VERBOSE_LOGGING` prints debug and tables
* `DRY_RUN=1` skips Safe transactions and only logs what would have been executed
* Keeps running: initial run, then every minute

### GP CRC App

* Walks block ranges from `START_AT_BLOCK` to the safe head (`head - CONFIRMATION_BLOCKS`) and fetches `RegisterHuman` events via `circles_events`
* Deduplicates avatars, checks them against the blacklist in chunks, and verifies a configured Metri Pay safe exists
* Skips avatars without safes or already trusted in `GP_CRC_GROUP_ADDRESS`; trusts the rest in batches (default 10) with retry logic
* Supports dry-run logging, verbose logging, and optional Slack notifications for start, shutdown, and errors
* Runs every 10 minutes

### OIC App

* Monitors **AffiliateGroupChanged** events for trust relationship updates
* Calculates desired trustees by intersecting:
  * Addresses trusted by any MetaOrg trustee
  * Current affiliates in the registry
* Performs batch trust/untrust operations to reconcile differences
* Supports incremental scanning to avoid re-processing old events
* Can run in dry-run mode for testing without making transactions
* Configurable refresh intervals and batch sizes

### Dublin TMS App

* Walks block ranges from `DUBLIN_TMS_START_BLOCK` to `head - DUBLIN_TMS_CONFIRMATION_BLOCKS` (or `DUBLIN_TMS_TO_BLOCK` when set)
* Fetches `RegisterHuman(human, originInviter, proxyInviter)` logs from the fixed invitation module `0x00738aca013B7B2e6cfE1690F0021C3182Fa40B5`
* Filters to events where `originInviter` is in the fixed Dublin inviter allowlist
* Deduplicates `human` addresses, skips already-trusted avatars in `DUBLIN_TMS_ADDRESS`, and trusts remaining avatars in batches
* Supports dry-run logging and startup/shutdown/run-error Slack notifications

## Operational notes

### General
* Make sure the configured Safe owns the appropriate **service** roles and that the signer key belongs to a Safe owner
* Slack notifications are best-effort; failures may throw and crash the process
* Services are designed to fail loudly on errors and require a supervisor to monitor and restart
* Replace placeholder values (`your_private_key_here`, etc.) with actual values in Docker commands

### CRC Backers App
* `CRC_BACKERS_SAFE_ADDRESS` must be the backers group's **service** and the signer key must belong to that Safe
* If you change the factory address, bump `START_AT_BLOCK` accordingly
* Service is stateless and does not store data between runs

### GP CRC App
* `GP_CRC_GROUP_ADDRESS` must match the group you intend to automatically trust new avatars into
* Provide `GP_CRC_SAFE_ADDRESS` plus `GP_CRC_SAFE_SIGNER_PRIVATE_KEY` unless `DRY_RUN=1`
* `METRI_SAFE_GRAPHQL_URL` is required; add `METRI_SAFE_API_KEY` if the endpoint is restricted
* `DRY_RUN=1` will log intended trust batches without submitting transactions

### OIC App  
* `OIC_SERVICE_PRIVATE_KEY` is used for direct EOA execution when `DRY_RUN=0`
* If set, `OIC_SERVICE_EOA` must match the address derived from `OIC_SERVICE_PRIVATE_KEY`
* OIC start block is hardcoded to `41734312`
* `OIC_META_ORG_ADDRESS` is required - this is the MetaOrg whose trustees will be monitored
* Use `DRY_RUN=1` for testing without making actual blockchain transactions
* Service maintains incremental state to avoid re-processing old events

### Dublin TMS App
* `DUBLIN_TMS_SERVICE_EOA` should be the group service EOA (defaults to `0x20a3C619De4C15E360d30F329DBCfe5bb618654f`)
* `DUBLIN_TMS_SERVICE_PRIVATE_KEY` must match `DUBLIN_TMS_SERVICE_EOA` when `DRY_RUN=0`
* Set `DUBLIN_TMS_TO_BLOCK` to run a bounded historical backfill
* If `DUBLIN_TMS_TO_BLOCK` is unset, the app follows the chain head with the configured confirmation buffer

### Gnosis Group App
* Fetches registered human avatars and filters out blacklisted addresses
* Calls a relative trust scoring service to rank avatars by configured targets
* Uses a Safe for execution; set `GNOSIS_GROUP_SAFE_ADDRESS` plus `GNOSIS_GROUP_SAFE_SIGNER_PRIVATE_KEY` for a 1/n Safe owner
* `GNOSIS_GROUP_DRY_RUN=1` (or `DRY_RUN=1`) skips blacklist and scoring service calls while logging the batches that would be requested

### Router TMS
* `ROUTER_SAFE_ADDRESS` must control the router's executor role; signer key must belong to that Safe
* `ROUTER_BASE_GROUP_ADDRESS` determines which base group memberships are required before enabling routing
* Use `DRY_RUN=1` to log planned enablements without sending transactions

### Docker Notes
* The Dockerfile uses `APP_NAME` build argument to determine which app to run
* Environment variables can be passed directly with `-e` flags instead of using `.env` files
* The container runs as the `node` user for security
