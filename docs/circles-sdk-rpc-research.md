# Circles SDK & RPC Research (2026-03-10)

## Current State in group-tms

- Uses `@circles-sdk/data` v0.29.1 (old SDK)
- `CirclesRpcService` manually wraps `CirclesRpc` + `CirclesData` from old SDK
- TODO comment in code references `@aboutcircles/sdk-rpc` from `sdk-v2` repo `feature/new_rpc_methods` branch
- Current methods: `fetchAllTrustees`, `fetchBackingInitiated/CompletedEvents`, `fetchAllBaseGroups`, `isHuman`

## New SDK: `@circles-sdk/sdk` (repo: aboutcircles/circles-sdk)

Monorepo with packages. Key classes:

### CirclesData (query layer)
| Method | Params | Returns | Notes |
|--------|--------|---------|-------|
| `getAvatarInfo` | `address` | `AvatarRow` | Single avatar |
| **`getAvatarInfoBatch`** | `Address[]` | `AvatarRow[]` | **Batch up to 1000** |
| `getTrustRelations` | `address, pageSize` | `CirclesQuery<TrustListRow>` | Paginated, in+out |
| `getAggregatedTrustRelations` | `address, version?` | `TrustRelationRow[]` | Groups mutual trusts |
| `getTokenBalances` | `address, asTimeCircles` | `TokenBalanceRow[]` | |
| `getTotalBalance` / `getTotalBalanceV2` | `address, asTimeCircles` | `string` | |
| `getTransactionHistory` | `address, pageSize` | `CirclesQuery<TransactionHistoryRow>` | |
| `getInvitationsFrom` | `address, accepted?` | `Address[]` | |
| `findGroups` | `pageSize, filter` | `CirclesQuery<GroupRow>` | Used by group-tms |

### CirclesQuery (generic paginated wrapper)
- Wraps `circles_query` RPC method
- `queryNextPage()` returns bool, access `currentPage.results`
- Can construct custom queries against any namespace/table

### Avatar (write layer)
- `trust(address | address[])` - batch trust via multicall
- `untrust(address | address[])` - batch untrust
- `trustBatchWithConditions(members[], expiry?)` - BaseGroup only

## Circles Nethermind Plugin - Custom RPC Methods

### Direct Query Methods

| RPC Method | Params | Returns |
|------------|--------|---------|
| **`circles_query`** | `SelectDto` | `{Columns, Rows}` |
| `circles_events` | `address?, fromBlock, toBlock, eventTypes[], filterPredicates[]` | Paginated events |
| `circles_tables` | none | All available namespace/table combos |
| `circles_getTotalBalance` | `address, asTimeCircles?` | `string` |
| `circlesV2_getTotalBalance` | `address, asTimeCircles?` | `string` |
| `circles_getTokenBalances` | `address, asTimeCircles?` | `[{tokenId, balance, tokenOwner}]` |
| `circles_getTrustRelations` | `address` | `{User, Trusts[], TrustedBy[]}` |
| `circles_getCommonTrust` | `address1, address2, version?` | `Address[]` |
| `circles_searchProfiles` | `text, limit?, offset?, types?` | `Profile[]` |

### Batch Methods (max 1000 per call)

| RPC Method | Params | Returns |
|------------|--------|---------|
| **`circles_getAvatarInfoBatch`** | `Address[]` | `AvatarRow?[]` |
| **`circles_getProfileCidBatch`** | `Address[]` | `string?[]` |
| **`circles_getProfileByAddressBatch`** | `Address[]` | `Profile?[]` |
| **`circles_getTokenInfoBatch`** | `Address[]` | `TokenInfo?[]` |

### Single-item variants
- `circles_getAvatarInfo(address)` -> `AvatarRow`
- `circles_getProfileCid(address)` -> `string`
- `circles_getProfileByAddress(address)` -> `Profile`
- `circles_getTokenInfo(tokenAddress)` -> `TokenInfo`

### AvatarRow fields
`Version, Type, Avatar, TokenId, HasV1, V1Token, CidV0, IsHuman, Name, Symbol`

## circles_query - The Power Method

### SelectDto structure
```json
{
  "Namespace": "V_Crc",
  "Table": "Avatars",
  "Columns": [],          // empty = all columns
  "Filter": [
    { "Type": "FilterPredicate", "FilterType": "Equals", "Column": "isHuman", "Value": true }
  ],
  "Order": [{ "Column": "blockNumber", "SortOrder": "ASC" }],
  "Limit": 1000,
  "Distinct": false
}
```

### Filter operators
`Equals`, `NotEquals`, `GreaterThan`, `GreaterThanOrEquals`, `LessThan`, `LessThanOrEquals`, `Like`, `NotLike`, `In`, `NotIn`

### Available Namespaces & Key Tables

**V_Crc** (combined V1+V2 views - most useful):
- `Avatars` - all avatars across versions
- `TrustRelations` - all trust relations across versions
- `Transfers` - all transfers
- `Tokens`
- `TransferSummary`
- `Stats`

**V_CrcV2** (V2-only views):
- `Avatars`, `TrustRelations`, `Transfers`
- `GroupMemberships`, `Groups`
- `GroupVaultBalancesByToken`, `TotalSupply`
- Various time-windowed aggregates (1h, 1d)

**V_CrcV1** (V1-only views):
- `Avatars`, `TrustRelations`, `Transfers`
- `BalancesByAccountAndToken`, `TotalSupply`

**CrcV2** (raw V2 events):
- `RegisterHuman`, `RegisterGroup`, `RegisterOrganization`
- `Trust`, `TransferSingle`, `TransferBatch`
- `PersonalMint`, `CirclesBackingDeployed`, `CirclesTokenDeployed`
- `Erc20WrapperTransfer`, `Deposit/WithdrawInflationary`, `Deposit/WithdrawDemurraged`
- `StreamCompleted`, `RegisterShortName`, `UpdateMetadataDigest`, `CidV0`
- `CreateVault`, `CollateralLockedSingle/Batch`, `GroupRedeem*`

**CrcV1** (raw V1 events):
- `HubTransfer`, `Signup`, `OrganizationSignup`, `Trust`, `Transfer`

## Key Answers for group-tms

### Get all registered humans in one call?
**Yes** - use `circles_query` with:
```json
{ "Namespace": "V_CrcV2", "Table": "Avatars", "Columns": [],
  "Filter": [{"Type":"FilterPredicate","FilterType":"Equals","Column":"type","Value":"human"}],
  "Limit": 1000 }
```
Paginate by adding a `GreaterThan` filter on `blockNumber` from last result.
Alternatively, `circles_getAvatarInfoBatch` if you already have addresses.

### Batch trust query?
**Yes** - `circles_getTrustRelations(address)` returns ALL trusts for one address in one call (no pagination needed).
For bulk: use `circles_query` on `V_Crc.TrustRelations` with filters.

### What does the plugin provide beyond standard Ethereum JSON-RPC?
Everything above: indexed event queries, aggregated views, trust graph queries, profile resolution, batch lookups. Essentially a full indexed read layer on top of Circles protocol state.

### Is there a SQL-like query interface?
**Yes** - `circles_query` is exactly this. SelectDto is a structured SQL-like query with namespace/table, column selection, filtering with operators, ordering, limit, and distinct support.
