# @decibeltrade/sdk

TypeScript SDK for interacting with Decibel, a fully on-chain trading engine built on Aptos.

**📚 [View Full Documentation →](https://docs.decibel.trade)**

## Overview

The Decibel TypeScript SDK provides a clean, typed interface to interact with Decibel on Aptos:

- **Read operations** (`DecibelReadDex`) — Query markets, depth, prices, trades, positions, orders, subaccounts, vaults
- **Write operations** (`DecibelWriteDex`) — Place/cancel orders, manage positions and subaccounts, vault operations, delegation

## Installation

```bash
npm install @decibeltrade/sdk @aptos-labs/ts-sdk zod
```

```bash
yarn add @decibeltrade/sdk @aptos-labs/ts-sdk zod
```

```bash
pnpm add @decibeltrade/sdk @aptos-labs/ts-sdk zod
```

For TypeScript in Node.js environments, you may also want:

```bash
npm install -D @types/ws
```

## Quick Start

### Read: Market and Account Data

```typescript
import { DecibelReadDex, TESTNET_CONFIG } from "@decibeltrade/sdk";

const read = new DecibelReadDex(TESTNET_CONFIG, {
  nodeApiKey: process.env.APTOS_NODE_API_KEY, // required
  onWsError: (error) => console.error("WebSocket error:", error), // optional
});

// Get all markets
const markets = await read.markets.getAll();

// Get account overview
const account = await read.accountOverview.getByAddr("0x...account");

// Get market prices
const prices = await read.marketPrices.getAll();

// Get order book depth
const depth = await read.marketDepth.getBySymbol("BTC-PERP", { depth: 10 });
```

### Write: Submit Transactions

```typescript
import { DecibelReadDex, DecibelWriteDex, TESTNET_CONFIG } from "@decibeltrade/sdk";
import { Ed25519Account, Ed25519PrivateKey } from "@aptos-labs/ts-sdk";

const account = new Ed25519Account({
  privateKey: new Ed25519PrivateKey(process.env.PRIVATE_KEY!),
});

const read = new DecibelReadDex(TESTNET_CONFIG, {
  nodeApiKey: process.env.APTOS_NODE_API_KEY,
});

const write = new DecibelWriteDex(TESTNET_CONFIG, account, {
  nodeApiKey: process.env.APTOS_NODE_API_KEY, // optional
});

const markets = await read.markets.getAll();
const market = markets.find((m) => m.market_addr === "0x...");
if (!market) throw new Error("Market not found");

function amountToChainUnits(amount: number, decimals: number) {
  return Math.floor(amount * 10 ** decimals);
}

// Place an order
const order = await write.placeOrder({
  subaccountAddr: "0x...",
  marketAddr: "0x...",
  price: amountToChainUnits(5.67, market.px_decimals),
  size: amountToChainUnits(1, market.sz_decimals),
  isBuy: true,
  timeInForce: 0, // GoodTillCanceled
});
```

## Documentation

### Getting Started

- [SDK Overview](https://docs.decibel.trade/typescript-sdk/overview) - Introduction to the TypeScript SDK
- [Installation](https://docs.decibel.trade/typescript-sdk/installation) - Install and configure the SDK
- [Configuration](https://docs.decibel.trade/typescript-sdk/configuration) - Network configuration and presets

### Read SDK

- [Read SDK Guide](https://docs.decibel.trade/typescript-sdk/read-sdk) - Query market data and account information
  - Market data (prices, depth, trades, candlesticks)
  - Account overview and positions
  - Order history and open orders
  - Subaccounts and delegations
  - Vault information
  - Campaign rewards, including affiliate commissions

### Write SDK

- [Write SDK Guide](https://docs.decibel.trade/typescript-sdk/write-sdk) - Build and submit transactions
  - Place and cancel orders
  - TWAP and bulk orders
  - Position management (TP/SL)
  - Subaccount management
  - Vault operations
  - Delegation

### Advanced

- [Advanced Usage](https://docs.decibel.trade/typescript-sdk/advanced) - Advanced SDK features and patterns

## Configuration

The SDK supports multiple network configurations:

```typescript
import { MAINNET_CONFIG, TESTNET_CONFIG, LOCAL_CONFIG, DOCKER_CONFIG } from "@decibeltrade/sdk";

// Mainnet
const read = new DecibelReadDex(MAINNET_CONFIG);

// Testnet
const read = new DecibelReadDex(TESTNET_CONFIG);

// Local development
const read = new DecibelReadDex(LOCAL_CONFIG);

// Docker environment
const read = new DecibelReadDex(DOCKER_CONFIG);
```

### Custom Configuration

```typescript
import { DecibelConfig } from "@decibeltrade/sdk";
import { Network } from "@aptos-labs/ts-sdk";

const customConfig: DecibelConfig = {
  network: Network.CUSTOM,
  fullnodeUrl: "https://api.testnet.aptoslabs.com/v1",
  tradingHttpUrl: "https://api.testnet.aptoslabs.com/decibel",
  tradingWsUrl: "wss://api.testnet.aptoslabs.com/decibel/ws",
  gasStationUrl: "https://api.testnet.aptoslabs.com/gs/v1", // optional: enables gas sponsorship
  gasStationApiKey: "your-gas-station-api-key", // optional: enables gas sponsorship
  gasStationAddress: "0x...", // optional: fee-payer address, required for encrypted submission
  deployment: {
    package: "0x...",
    usdc: "0x...",
    testc: "0x...",
    perpEngineGlobal: "0x...",
  },
};
```

## When to Use Which

- **Use `DecibelReadDex`** when you need market data, order/position history, or account state. No private keys required.
- **Use `DecibelWriteDex`** for on-chain actions and trading. In browsers, avoid embedding private keys — prefer session keys or a wallet and pass `accountOverride` for specific calls.

## Read Operations API

### DecibelReadDex

The main read client providing access to all market data and account information.

#### Constructor

```typescript
new DecibelReadDex(config: DecibelConfig, opts?: {
  nodeApiKey?: string;
  onWsError?: (error: ErrorEvent) => void;
  onChainFallback?: (info: ChainFallbackInfo) => void;
})
```

#### Global Methods

```typescript
// Get global perpetual engine state
await readDex.globalPerpEngineState();

// Get collateral balance decimals
await readDex.collateralBalanceDecimals();

// Get USDC decimals (cached)
await readDex.usdcDecimals();

// Get USDC balance for an address
await readDex.usdcBalance("0x123...");

// Get account balance
await readDex.accountBalance("0x123...");

// Read on-chain fungible-asset metadata (symbol, decimals, name) for any
// asset address — e.g. entries in account_overview.secondary_collateral
await readDex.fungibleAssetMetadata("0x...asset_metadata");

// Resolve a spot market's base/quote asset addresses (not exposed by /markets)
await readDex.spotMarketAssets("0x...spot_market");

// Get position size
await readDex.positionSize("0x123...", "metadata_address");

// Get crossed position
await readDex.getCrossedPosition("0x123...");
```

### Markets

Access market information and configuration.

```typescript
// Get all available perp markets
const markets = await readDex.markets.getAll();

// Include spot markets too (rows are discriminated by asset_type), or get
// spot markets alone. Narrow union rows with isSpotMarket / isPerpMarket.
const allMarkets = await readDex.markets.getAll({ includeSpot: true });
const spotMarkets = await readDex.markets.getAllSpot();

// Get specific market by name
const market = await readDex.markets.getByName("BTC-USD");

// Get market by symbol
const market = await readDex.markets.getBySymbol("BTC-PERP");

// List all market addresses
const addresses = await readDex.markets.listMarketAddresses();

// Get market name by address
const name = await readDex.markets.marketNameByAddress("0x123...");
```

### Campaign Rewards

```typescript
const campaigns = await readDex.campaigns.getActive();
const summary = await readDex.campaigns.getSummary({
  accountAddress: "0x...",
  limit: 20,
  offset: 0,
});
```

Campaign metadata, `summary.claims`, and `summary.breakdownByType` use `campaignType`:
`"fee_rebate"`, `"maker_incentive"`, `"liquidation_rebate"`, `"volume_milestone"`,
`"first_funded_trial"`, or `"affiliate"`. Unknown campaign types fail response validation.
Reward amounts are raw token units (divide USDC amounts by `10 ** 6`). Each claim exposes
`hasAllocation`, `readyToClaim`, `claimedAmount`, `claimedAtTsSec`, and `claimTxHash`.

### Account Overview

Get comprehensive account information including balances and positions.

```typescript
// Get account overview
const overview = await readDex.accountOverview.getByAddr("subaccount_address", "30d"); // volume_window = "30d"

// Subscribe to real-time account updates
const unsubscribe = readDex.accountOverview.subscribeByAddr("subaccount_address", (data) =>
  console.log("Account update:", data),
);

// Later, unsubscribe
unsubscribe();
```

### User Fees

Get a subaccount's effective maker/taker fee rates, current fee tier, the full
VIP fee schedule, and its daily volume history for the on-chain fee window. Fee
rates are decimals (e.g. `0.00034` = 0.034%); volume values are whole-USD integer
strings.

```typescript
const fees = await readDex.userFees.getByAddr({ subAddr: "subaccount_address" });
// fees.user_taker_rate, fees.user_maker_rate, fees.fee_tier
// fees.fee_schedule.tiers.vip[], fees.daily_user_volume[]
```

### User Positions

Query user positions across markets.

```typescript
// Get all positions for a user
const positions = await readDex.userPositions.getByAddr({
  subAddr: "subaccount_address",
  includeDeleted: false,
  limit: 10,
});

// Get positions for specific market
const marketPositions = await readDex.userPositions.getByAddr({
  subAddr: "subaccount_address",
  marketAddr: "market_address",
  limit: 10,
});

// Subscribe to position updates
const unsubscribe = readDex.userPositions.subscribeByAddr("subaccount_address", (data) =>
  console.log("Position update:", data),
);
```

### User Orders

Query open orders and order history. The order endpoints serve perp and spot
on shared routes with a per-row `asset_type` discriminator; the list readers
default to `assetType: "perp"`. Pass `"spot"` to scope to spot, or `"all"` to
receive both products merged.

#### Open Orders

```typescript
// Get open orders (perp by default)
const openOrders = await readDex.userOpenOrders.getByAddr({ subAddr: "subaccount_address" });

// Spot only, or both products merged
const spotOrders = await readDex.userOpenOrders.getByAddr({
  subAddr: "subaccount_address",
  assetType: "spot",
});
const allOrders = await readDex.userOpenOrders.getByAddr({
  subAddr: "subaccount_address",
  assetType: "all",
});

// Subscribe to open orders updates
const unsubscribe = readDex.userOpenOrders.subscribeByAddr("subaccount_address", (data) =>
  console.log("Orders update:", data),
);
```

#### Order History

```typescript
// Get order history (perp by default; assetType works as above)
const orderHistory = await readDex.userOrderHistory.getByAddr({
  subAddr: "subaccount_address",
  limit: 50,
});

// Subscribe to order history updates
const unsubscribe = readDex.userOrderHistory.subscribeByAddr("subaccount_address", (data) =>
  console.log("Order history update:", data),
);
```

#### Single Order Lookup

```typescript
// Look up one order by orderId (perp + spot) or clientOrderId (perp only).
// assetType defaults to unset: the API checks perp first, then spot.
const order = await readDex.userOrders.getOrder({
  subAddr: "subaccount_address",
  market: "market_address",
  orderId: "42",
});
```

#### Bulk Orders

```typescript
// Get bulk orders (perp by default; assetType works as above)
const bulkOrders = await readDex.userBulkOrders.getByAddr({ subAddr: "subaccount_address" });

// Placement status of one bulk order by sequence number
const status = await readDex.userBulkOrders.getStatus({
  subAddr: "subaccount_address",
  market: "market_address",
  sequenceNumber: 7,
});

// Bulk order fills (optionally by market and sequence number range)
const fills = await readDex.userBulkOrders.getFills({
  subAddr: "subaccount_address",
  startSequenceNumber: 5,
  endSequenceNumber: 9,
});
```

### Market Data

#### Market Depth (Order Book)

```typescript
// Subscribe to depth updates (aggregationSize buckets price levels)
const unsubscribe = readDex.marketDepth.subscribeByName("BTC-USD", 1, (data) =>
  console.log("Depth update:", data),
);

// Spot markets derive a different address than perp markets with the same
// name, so pass the asset type (defaults to "perp")
const unsubSpot = readDex.marketDepth.subscribeByName("APT/USDC", 1, onDepth, "spot");

// Or skip name→address derivation when you already hold the market address
const unsubByAddr = readDex.marketDepth.subscribeByAddr(market.market_addr, 1, onDepth);

// Reset subscription (clear cached data)
readDex.marketDepth.resetSubscriptionByName("BTC-USD", 1);
readDex.marketDepth.resetSubscriptionByAddr(market.market_addr, 1);
```

#### Market Prices

```typescript
// Get current prices
const prices = await readDex.marketPrices.getByName("BTC-USD");
const prices = await readDex.marketPrices.getAll();

// Subscribe to price updates
const unsubscribe = readDex.marketPrices.subscribeByName("BTC-USD", (data) =>
  console.log("Price update:", data),
);
```

#### Market Trades

```typescript
// Get recent trades
const trades = await readDex.marketTrades.getByName({ marketName: "BTC-USD", limit: 50 });

// Spot markets: pass assetType (defaults to "perp")
const spotTrades = await readDex.marketTrades.getByName({
  marketName: "APT/USDC",
  assetType: "spot",
});

// Or skip name→address derivation when you already hold the market address
const tradesByAddr = await readDex.marketTrades.getByAddr({ marketAddr: market.market_addr });

// Subscribe to trade updates
const unsubscribe = readDex.marketTrades.subscribeByName("BTC-USD", (data) =>
  console.log("Trade update:", data),
);
const unsubSpot = readDex.marketTrades.subscribeByName("APT/USDC", onTrades, "spot");
const unsubByAddr = readDex.marketTrades.subscribeByAddr(market.market_addr, onTrades);
```

#### Candlesticks

```typescript
import { CandlestickInterval } from "@decibeltrade/sdk";

// Get historical candlestick data (assetType defaults to "perp"; pass "spot"
// for spot markets — perp and spot derive different addresses for the same name)
const candlesticks = await readDex.candlesticks.getByName({
  marketName: "BTC-USD",
  interval: CandlestickInterval.OneMinute,
  startTime: startTimestamp,
  endTime: endTimestamp,
});

// Or skip name→address derivation when you already hold the market address
const byAddr = await readDex.candlesticks.getByAddr({
  marketAddr: market.market_addr,
  interval: CandlestickInterval.OneMinute,
  startTime: startTimestamp,
  endTime: endTimestamp,
});

// Subscribe to candlestick updates
const unsubscribe = readDex.candlesticks.subscribeByName(
  "BTC-USD",
  CandlestickInterval.OneMinute,
  (data) => console.log("Candlestick update:", data),
);
const unsubByAddr = readDex.candlesticks.subscribeByAddr(
  market.market_addr,
  CandlestickInterval.OneMinute,
  (data) => console.log("Candlestick update:", data),
);
```

### Market Contexts

Get additional market metadata and context.

```typescript
// Get market contexts
const contexts = await readDex.marketContexts.getAll();

// Subscribe to market context updates
const unsubscribe = readDex.marketContexts.subscribeAll((data) =>
  console.log("Market contexts update:", data),
);
```

### User Trade History

Query historical trade data for a user.

```typescript
// Get trade history
const trades = await readDex.userTradeHistory.getByAddr({
  subAddr: "subaccount_address",
  marketAddr: "market_address", // optional
  limit: 100,
});

// Subscribe to trade history updates
const unsubscribe = readDex.userTradeHistory.subscribeByAddr("subaccount_address", (data) =>
  console.log("Trade history update:", data),
);
```

### User Funding History

Query funding payment history.

```typescript
// Get funding history
const funding = await readDex.userFundingHistory.getByAddr({
  subAddr: "subaccount_address",
  marketAddr: "market_address", // optional
  limit: 50,
});

// Subscribe to funding history updates
const unsubscribe = readDex.userFundingHistory.subscribeByAddr("subaccount_address", (data) =>
  console.log("Funding history update:", data),
);
```

### User Subaccounts

```typescript
// Get all subaccounts for a user
const subaccounts = await readDex.userSubaccounts.getByAddr("account_address");
```

### Vaults

```typescript
// Get user vault positions
const userVaults = await readDex.userVaults.getByAddr("account_address");

// Get public vault information
const vaults = await readDex.vaults.getAll();
```

### Funded First Trade

Campaign reads for the Funded First Trade (FFT) flow. Totals are SQL-level counts:
rows the server skips while shaping still count, so drive pagination with
`offset + limit < total`, never by probing for an empty/short page.

```typescript
// Composed on-chain eligibility snapshot (locks, credits, budgets, live tier/payout config)
const eligibility = await readDex.fundedFirstTrade.getEligibility({ account: "account_address" });

// Active trial, or null
const activeTrial = await readDex.fundedFirstTrade.getActiveTrial({ account: "account_address" });

// Terminal trial history — { history, historyTotalCount }
const page = await readDex.fundedFirstTrade.getTrialHistory({
  account: "account_address",
  limit: 20,
  offset: 0,
});

// Campaign reward locks — { account, locks, total_count }; server default limit 10
const locks = await readDex.fundedFirstTrade.getCampaignLocks({
  account: "account_address",
  status: "Active", // optional: "Active" | "Claimed"
});

// Real-time trial updates (TrialOpened / TrialClosed / TrialResetByAdmin)
const unsubscribe = readDex.fundedFirstTrade.subscribeByAddr("account_address", ({ trials }) => {
  console.log(trials);
});
```

## Write Operations API

### DecibelWriteDex

The main write client for executing trades and managing Trading Accounts, positions, vaults, and campaign rewards.

#### Constructor

```typescript
import { GasPriceManager } from "@decibeltrade/sdk";
import { Ed25519Account, Ed25519PrivateKey } from "@aptos-labs/ts-sdk";

const account = new Ed25519Account({
  privateKey: new Ed25519PrivateKey("your-private-key"),
});

const gasPriceManager = new GasPriceManager(config);

const writeDex = new DecibelWriteDex(config, account, {
  nodeApiKey: process.env.APTOS_NODE_API_KEY,
  skipSimulate: false,
  gasPriceManager,
  timeDeltaMs: 0,
  defaultEncrypted: false,
});
```

`defaultEncrypted` decides whether front-run-sensitive writes are submitted as encrypted pending
transactions; it is readable back off the instance as `writeDex.defaultEncrypted`. Encrypted
submission requires a fullnode that exposes an encryption key, and — when a Gas Station is
configured — a `gasStationAddress` in the config, because the fee payer is baked into the encrypted
payload at build time. Check that ahead of time with `configSupportsEncryptedSubmission(config)`.

### Public write methods

- Trading Accounts and collateral:
  `renameSubaccount`,
  `createSubaccount`,
  `adminCreateSubaccount`,
  `sendSubaccountTx`,
  `withSubaccount`,
  `deposit`,
  `withdraw`,
  `withdrawNonCollateral`,
  `configureUserSettingsForMarket`,
  `buildDeactiveSubaccountTx`
- Orders and matching:
  `placeOrder`,
  `triggerMatching`,
  `placeTwapOrder`,
  `cancelOrder`,
  `cancelClientOrder`,
  `cancelBulkOrder`,
  `updateOrder`,
  `cancelTwapOrder`
- Spot trading:
  `placeSpotOrder`,
  `cancelSpotOrder`,
  `placeSpotBulkOrder`,
  `cancelSpotBulkOrder`,
  `cancelSpotBulkOrderAtPriceLevel`,
  `approveMaxSpotBuilderFee`,
  `revokeMaxSpotBuilderFee`,
  `setHoldAsNonCollateral`,
  `processSpotPendingRequests`
- Position TP/SL:
  `placeTpSlOrderForPosition`,
  `updateTpOrderForPosition`,
  `updateSlOrderForPosition`,
  `cancelTpSlOrderForPosition`
- Delegation, vaults, and rewards:
  `delegateTradingToForSubaccount`,
  `revokeDelegation`,
  `createVault`,
  `buildCreateVaultTx`,
  `buildActivateVaultTx`,
  `buildDepositToVaultTx`,
  `depositToVault`,
  `withdrawFromVault`,
  `buildDelegateDexActionsToTx`,
  `approveMaxBuilderFee`,
  `revokeMaxBuilderFee`,
  `claimCampaignReward`,
  `openFftTrial`,
  `claimFftUnlock`,
  `settleFftTrial`

### Trading Accounts and Collateral

```typescript
// Create a new subaccount
await writeDex.createSubaccount();

// Admin-only: create a subaccount for another owner
await writeDex.adminCreateSubaccount("0x...owner");

// Rename a subaccount via trading API
await writeDex.renameSubaccount({
  subaccountAddress: "0x...subaccount",
  newName: "Treasury",
});

// Deposit collateral to primary subaccount
await writeDex.deposit(1000000); // amount in smallest unit

// Deposit to specific subaccount
await writeDex.deposit(1000000, "subaccount_address");

// Withdraw from subaccount
await writeDex.withdraw(500000, "subaccount_address");

// Withdraw a non-collateral asset from a subaccount
await writeDex.withdrawNonCollateral("0x...asset_metadata", 250000, "subaccount_address");
```

### Trading Delegation and Builder Fees

```typescript
// Delegate trading permissions
await writeDex.delegateTradingToForSubaccount({
  subaccountAddr: "your_subaccount",
  accountToDelegateTo: "delegate_account_address",
  expirationTimestampSecs: 1735689600, // optional
});

// Revoke delegation
await writeDex.revokeDelegation({
  subaccountAddr: "your_subaccount",
  accountToRevoke: "delegate_account_address",
});

// Approve and revoke builder fees (values are basis points)
await writeDex.approveMaxBuilderFee({
  builderAddr: "0x...builder",
  maxFee: 25,
});

await writeDex.revokeMaxBuilderFee({
  builderAddr: "0x...builder",
});
```

### Market Configuration

```typescript
// Configure user settings for a market
await writeDex.configureUserSettingsForMarket({
  marketAddr: "market_address",
  subaccountAddr: "subaccount_address",
  isCross: true, // cross-margin mode
  userLeverage: 1000, // 10x leverage (basis points)
});
```

### Order Management

```typescript
import { DecibelReadDex, getMarketAddr, TimeInForce } from "@decibeltrade/sdk";

const readDex = new DecibelReadDex(config, {
  nodeApiKey: process.env.APTOS_NODE_API_KEY,
});

const marketAddr = getMarketAddr("BTC-USD", config.deployment.perpEngineGlobal).toString();
const market = await readDex.markets.getByName("BTC-USD");
if (!market) throw new Error("Market not found");

const amountToChainUnits = (amount: number, decimals: number) =>
  Math.floor(amount * 10 ** decimals);

// Place a limit order
const result = await writeDex.placeOrder({
  marketName: "BTC-USD",
  price: amountToChainUnits(45_000, market.px_decimals),
  size: amountToChainUnits(1.5, market.sz_decimals),
  isBuy: true,
  timeInForce: TimeInForce.GoodTillCanceled,
  isReduceOnly: false,
  clientOrderId: "12345", // optional
  subaccountAddr: "subaccount_address", // optional
});

// Place order with stop-loss and take-profit
await writeDex.placeOrder({
  marketName: "BTC-USD",
  price: amountToChainUnits(45_000, market.px_decimals),
  size: amountToChainUnits(1, market.sz_decimals),
  isBuy: true,
  timeInForce: TimeInForce.GoodTillCanceled,
  isReduceOnly: false,
  stopPrice: amountToChainUnits(44_000, market.px_decimals),
  tpTriggerPrice: amountToChainUnits(46_000, market.px_decimals),
  tpLimitPrice: amountToChainUnits(45_900, market.px_decimals),
  slTriggerPrice: amountToChainUnits(44_000, market.px_decimals),
  slLimitPrice: amountToChainUnits(44_100, market.px_decimals),
});

// Place order with builder fee and automatic tick-size snapping
await writeDex.placeOrder({
  marketName: "BTC-USD",
  price: amountToChainUnits(45_000, market.px_decimals),
  size: amountToChainUnits(1, market.sz_decimals),
  isBuy: true,
  timeInForce: TimeInForce.GoodTillCanceled,
  isReduceOnly: false,
  builderAddr: "builder_account_address",
  builderFee: 100,
  tickSize: market.tick_size,
});

// Place a TWAP order
await writeDex.placeTwapOrder({
  marketName: "BTC-USD",
  size: amountToChainUnits(10, market.sz_decimals),
  isBuy: true,
  isReduceOnly: false,
  twapFrequencySeconds: 60,
  twapDurationSeconds: 3600,
});

// Cancel orders
// Choose `marketName` when you only have a symbol/name.
await writeDex.cancelOrder({
  orderId: 12345,
  marketName: "BTC-USD",
  subaccountAddr: "subaccount_address", // optional
});

// Choose `marketAddr` when the address is already resolved/cached.
await writeDex.cancelOrder({
  orderId: 12345,
  marketAddr,
  subaccountAddr: "subaccount_address", // optional
});

await writeDex.cancelClientOrder({
  clientOrderId: "54321",
  marketName: "BTC-USD",
});

await writeDex.cancelTwapOrder({
  orderId: "twap_order_id",
  marketAddr,
});

// Cancel all bulk orders for a market
// By market name (symbol-driven flow)
await writeDex.cancelBulkOrder({
  marketName: "BTC-USD",
  subaccountAddr: "subaccount_address", // optional
});

// By market address (address-driven flow)
await writeDex.cancelBulkOrder({
  marketAddr,
  subaccountAddr: "subaccount_address", // optional
});

// Update an existing order
await writeDex.updateOrder({
  orderId: 12345,
  marketAddr,
  price: amountToChainUnits(45_500, market.px_decimals),
  size: amountToChainUnits(1.25, market.sz_decimals),
  isBuy: true,
  timeInForce: TimeInForce.GoodTillCanceled,
  isReduceOnly: false,
  tpTriggerPrice: amountToChainUnits(47_000, market.px_decimals),
  tpLimitPrice: amountToChainUnits(46_900, market.px_decimals),
});
```

### Spot Trading

All spot methods are subaccount-scoped (defaulting to the primary Trading Account) and accept `marketName` or `marketAddr`, like `cancelOrder`.

```typescript
import { roundToTickSizeForSide, TimeInForce } from "@decibeltrade/sdk";

const spotMarkets = await readDex.markets.getAllSpot();
const spotMarket = spotMarkets.find((m) => m.market_name === "APT/USDC");
if (!spotMarket) throw new Error("Market not found");

// Place a spot limit order. On spot markets sz_decimals is the base-asset
// decimals and px_decimals the quote-asset decimals.
const spotResult = await writeDex.placeSpotOrder({
  marketName: "APT/USDC",
  price: amountToChainUnits(4.25, spotMarket.px_decimals),
  size: amountToChainUnits(100, spotMarket.sz_decimals),
  isBuy: true,
  timeInForce: TimeInForce.GoodTillCanceled,
  tickSize: spotMarket.tick_size, // optional price snapping
});

// Spot placement is CBS-backed and async: when funding needs a rate-limited
// CBS withdrawal the transaction succeeds but the order is queued, not
// resting. `pendingCbs: true` signals this — resolve the outcome via
// readDex.userOrders.getOrder / userOrderHistory, which cover every terminal
// state. userOpenOrders only sees orders that rest, so an IOC order never
// shows up there whether it filled, cancelled, or is still queued.
if (spotResult.success && spotResult.pendingCbs) {
  console.log("Order queued behind a CBS withdrawal", spotResult.orderId);
}

// There is no market order on chain for spot: submit an IOC limit at the
// slippage cap. `roundToTickSizeForSide` is the same side-safe rounding
// `tickSize` applies internally (buys down, sells up, so the cap is never
// crossed) — pre-round with it to know the exact price the order is
// submitted and escrowed at. It is idempotent.
//
// Spot has no perp-style price feed, so the reference price comes from the
// spot asset contexts (mid of the book, or the last trade).
const spotContexts = await readDex.spotAssetContexts.getAll();
const spotContext = spotContexts.find((c) => c.market_addr === spotMarket.market_addr);
const mid = spotContext?.mid ?? spotContext?.last_price;
if (mid == null) throw new Error("No spot reference price");

// Scale WITHOUT rounding first: amountToChainUnits rounds to the nearest
// integer, which can carry the value across a tick boundary and put the
// submitted price on the wrong side of the cap. Let the side-safe rounding
// consume the exact fractional value instead.
const cap = mid * 1.01 * 10 ** spotMarket.px_decimals;
const submittedPrice = roundToTickSizeForSide(cap, spotMarket.tick_size, true);

const spotMarketOrder = await writeDex.placeSpotOrder({
  marketName: "APT/USDC",
  price: submittedPrice,
  size: amountToChainUnits(100, spotMarket.sz_decimals),
  isBuy: true,
  timeInForce: TimeInForce.ImmediateOrCancel,
  tickSize: spotMarket.tick_size,
});

// Cancel a spot order
if (spotResult.success && spotResult.orderId) {
  await writeDex.cancelSpotOrder({
    orderId: spotResult.orderId,
    marketName: "APT/USDC",
  });
}

// Spot bulk orders (funded from the subaccount PFS only)
await writeDex.placeSpotBulkOrder({
  marketName: "APT/USDC",
  sequenceNumber: 1, // strictly increasing per market
  bidPrices: [amountToChainUnits(4.2, spotMarket.px_decimals)],
  bidSizes: [amountToChainUnits(50, spotMarket.sz_decimals)],
  askPrices: [amountToChainUnits(4.3, spotMarket.px_decimals)],
  askSizes: [amountToChainUnits(50, spotMarket.sz_decimals)],
});

await writeDex.cancelSpotBulkOrderAtPriceLevel({
  marketName: "APT/USDC",
  price: amountToChainUnits(4.2, spotMarket.px_decimals),
  isBuy: true,
});

await writeDex.cancelSpotBulkOrder({ marketName: "APT/USDC" });

// Spot builder fees (basis points). Unlike perp, the builder address may be
// a subaccount or a primary wallet.
await writeDex.approveMaxSpotBuilderFee({ builderAddr: "0x...builder", maxFee: 10 });
await writeDex.revokeMaxSpotBuilderFee({ builderAddr: "0x...builder" });

// Keep future deposits of an asset in the PFS (non-collateral) instead of
// routing them into CBS collateral. Flag-only: existing balances don't move.
await writeDex.setHoldAsNonCollateral({ assetAddr: "0x...asset_metadata", hold: true });
```

### Position Management

```typescript
const markets = await readDex.markets.getAll();
const market = markets.find((m) => m.market_addr === "market_address");
if (!market) throw new Error("Market not found");

// Place TP/SL order for an existing position
await writeDex.placeTpSlOrderForPosition({
  marketAddr: "market_address",
  tpTriggerPrice: amountToChainUnits(46_000, market.px_decimals),
  tpLimitPrice: amountToChainUnits(45_900, market.px_decimals),
  tpSize: amountToChainUnits(0.5, market.sz_decimals),
  slTriggerPrice: amountToChainUnits(44_000, market.px_decimals),
  slLimitPrice: amountToChainUnits(44_100, market.px_decimals),
  slSize: amountToChainUnits(1, market.sz_decimals),
  subaccountAddr: "subaccount_address",
});

// Update TP and SL orders independently
await writeDex.updateTpOrderForPosition({
  marketAddr: "market_address",
  prevOrderId: "previous_tp_order_id",
  tpTriggerPrice: amountToChainUnits(47_000, market.px_decimals),
  tpLimitPrice: amountToChainUnits(46_900, market.px_decimals),
  tpSize: amountToChainUnits(0.75, market.sz_decimals),
});

await writeDex.updateSlOrderForPosition({
  marketAddr: "market_address",
  prevOrderId: "previous_sl_order_id",
  slTriggerPrice: amountToChainUnits(43_800, market.px_decimals),
  slLimitPrice: amountToChainUnits(43_750, market.px_decimals),
  slSize: amountToChainUnits(1, market.sz_decimals),
});

await writeDex.cancelTpSlOrderForPosition({
  marketAddr: "market_address",
  orderId: 12345,
  subaccountAddr: "subaccount_address",
});
```

### Vaults and Campaign Rewards

```typescript
// Create a vault
await writeDex.createVault({
  // Asset metadata object address (for example USDC metadata), not a Move type tag
  contributionAssetType: writeDex.config.deployment.usdc,
  vaultName: "Basis Trade",
  vaultDescription: "Example strategy",
  vaultSocialLinks: [],
  vaultShareSymbol: "BASIS",
  feeBps: 0,
  feeIntervalS: 0,
  contributionLockupDurationS: 0,
  initialFunding: 0,
  acceptsContributions: false,
  delegateToCreator: false,
});

// Contribute to and redeem from a vault
await writeDex.depositToVault({
  vaultAddress: "0x...vault",
  amount: 1000000,
  subaccountAddr: "0x...subaccount",
});

await writeDex.withdrawFromVault({
  vaultAddress: "0x...vault",
  shares: 1000000,
});

// Build transactions for custom signing flows
await writeDex.buildCreateVaultTx({
  contributionAssetType: writeDex.config.deployment.usdc,
  vaultName: "Basis Trade",
  vaultDescription: "Example strategy",
  vaultSocialLinks: [],
  vaultShareSymbol: "BASIS",
  feeBps: 0,
  feeIntervalS: 0,
  contributionLockupDurationS: 0,
  initialFunding: 0,
  acceptsContributions: false,
  delegateToCreator: false,
  signerAddress: account.accountAddress,
});

await writeDex.buildActivateVaultTx({
  vaultAddress: "0x...vault",
  signerAddress: account.accountAddress,
});

await writeDex.buildDepositToVaultTx({
  vaultAddress: "0x...vault",
  amount: 1000000,
  signerAddress: account.accountAddress,
});

await writeDex.buildDelegateDexActionsToTx({
  vaultAddress: "0x...vault",
  accountToDelegateTo: "0x...delegate",
  signerAddress: account.accountAddress,
});

// Claim a campaign reward by numeric campaign ID
await writeDex.claimCampaignReward(42);
```

### Session Accounts

You can override the default account for specific transactions using session accounts:

```typescript
import { TimeInForce } from "@decibeltrade/sdk";
import { Ed25519Account } from "@aptos-labs/ts-sdk";

const sessionAccount = Ed25519Account.generate();
const market = await readDex.markets.getByName("BTC-USD");
if (!market) throw new Error("Market not found");

const amountToChainUnits = (amount: number, decimals: number) =>
  Math.floor(amount * 10 ** decimals);

await writeDex.placeOrder({
  marketName: "BTC-USD",
  price: amountToChainUnits(45_000, market.px_decimals),
  size: amountToChainUnits(1, market.sz_decimals),
  isBuy: true,
  timeInForce: TimeInForce.GoodTillCanceled,
  isReduceOnly: false,
  accountOverride: sessionAccount,
});
```

### Error Handling

All write operations return transaction results. For order placement, you get a structured result:

```typescript
type PlaceOrderResult =
  | {
      success: true;
      orderId: string | undefined;
      transactionHash: string;
    }
  | {
      success: false;
      error: string;
    };

const result = await writeDex.placeOrder({
  // ... order parameters
});

if (result.success) {
  console.log("Order placed successfully:", result.orderId);
  console.log("Transaction:", result.transactionHash);
} else {
  console.error("Order failed:", result.error);
}
```

## Constants and Enums

### Time in Force

```typescript
export const TimeInForce = {
  GoodTillCanceled: 0,
  PostOnly: 1,
  ImmediateOrCancel: 2,
} as const;
```

### Candlestick Intervals

```typescript
export enum CandlestickInterval {
  MINUTE_1 = "1m",
  MINUTE_5 = "5m",
  MINUTE_15 = "15m",
  HOUR_1 = "1h",
  HOUR_4 = "4h",
  DAY_1 = "1d",
}
```

## Utilities

### Address Utilities

```typescript
import { getPrimarySubaccountAddr, getMarketAddr } from "@decibeltrade/sdk";

// Get primary subaccount address for an account
const subaccountAddr = getPrimarySubaccountAddr(
  "account_address",
  sdkConfig.compatVersion,
  sdkConfig.deployment.package,
);

// Get market address from name
const marketAddr = getMarketAddr("BTC-USD", "perp_engine_global_address");
```

## WebSocket Subscriptions

All read operations that support real-time updates return an unsubscribe function:

```typescript
// Subscribe to multiple streams
const unsubscribeDepth = readDex.marketDepth.subscribeByName("BTC-USD", 1, handleDepth);
const unsubscribePrices = readDex.marketPrices.subscribeByName("BTC-USD", handlePrices);
const unsubscribeOrders = readDex.userOpenOrders.subscribeByAddr("subaccount", handleOrders);

// Clean up subscriptions
function cleanup() {
  unsubscribeDepth();
  unsubscribePrices();
  unsubscribeOrders();
}

// Handle errors
const readDex = new DecibelReadDex(TESTNET_CONFIG, {
  onWsError: (error) => {
    console.error("WebSocket error:", error);
  },
  // Fired (once per method per instance) when a trading-api read fails and is
  // rebuilt from on-chain views
  onChainFallback: ({ method, error }) => {
    console.warn(`${method} fell back to chain views:`, error);
  },
});

// The SDK reconnects and resubscribes automatically. Streaming-only topics get
// no replay of events missed during an outage — re-seed their state on:
const unregister = readDex.onWsReconnect(() => {
  // re-fetch WS-seeded state over HTTP
});
```

## TypeScript Types

The SDK is fully typed with Zod schemas for runtime validation. Import types for better development experience:

```typescript
import type {
  DecibelConfig,
  PerpMarket,
  UserPosition,
  MarketDepth,
  CandlestickData,
  AccountOverview,
  PlaceOrderResult,
} from "@decibeltrade/sdk";
```

## Best Practices

1. **Connection Management**: Reuse SDK instances where possible to maintain WebSocket connections.

2. **Error Handling**: Always wrap SDK calls in try-catch blocks and handle errors appropriately.

3. **Subscription Cleanup**: Always call unsubscribe functions to prevent memory leaks.

4. **Rate Limiting**: Be mindful of API rate limits when making frequent requests.

5. **Account Security**: Never expose private keys in client-side code. Use environment variables or secure key management.

6. **Precision**: Be careful with number precision for prices and sizes. The SDK handles decimal precision internally.

## Complete Trading Bot Example

```typescript
import { DecibelReadDex, DecibelWriteDex, TESTNET_CONFIG, TimeInForce } from "@decibeltrade/sdk";
import { Ed25519Account, Ed25519PrivateKey } from "@aptos-labs/ts-sdk";

class TradingBot {
  private readDex: DecibelReadDex;
  private writeDex: DecibelWriteDex;
  private subaccountAddr: string;

  constructor(privateKey: string, subaccountAddr: string) {
    this.readDex = new DecibelReadDex(TESTNET_CONFIG, {
      nodeApiKey: process.env.APTOS_NODE_API_KEY,
    });

    const account = new Ed25519Account({
      privateKey: new Ed25519PrivateKey(privateKey),
    });
    this.writeDex = new DecibelWriteDex(TESTNET_CONFIG, account, {
      nodeApiKey: process.env.APTOS_NODE_API_KEY,
    });
    this.subaccountAddr = subaccountAddr;
  }

  async start() {
    // Subscribe to market data
    this.readDex.marketPrices.subscribeByName("BTC-USD", this.handlePriceUpdate.bind(this));
    this.readDex.marketDepth.subscribeByName("BTC-USD", 1, this.handleDepthUpdate.bind(this));

    // Subscribe to account updates
    this.readDex.userPositions.subscribeByAddr(
      this.subaccountAddr,
      this.handlePositionUpdate.bind(this),
    );
  }

  private async handlePriceUpdate(priceData: any) {
    // Implement your trading logic here
    console.log("Price update:", priceData);
  }

  private async handleDepthUpdate(depthData: any) {
    // Analyze order book for trading opportunities
    console.log("Depth update:", depthData);
  }

  private async handlePositionUpdate(positionData: any) {
    // Monitor positions and manage risk
    console.log("Position update:", positionData);
  }

  async placeMarketBuyOrder(size: number) {
    try {
      const result = await this.writeDex.placeOrder({
        marketName: "BTC-USD",
        price: 0, // Market order (implementation may vary)
        size,
        isBuy: true,
        timeInForce: TimeInForce.ImmediateOrCancel,
        isReduceOnly: false,
        subaccountAddr: this.subaccountAddr,
      });

      if (result.success) {
        console.log(`Market buy order placed: ${result.orderId}`);
      } else {
        console.error(`Order failed: ${result.error}`);
      }
    } catch (error) {
      console.error("Error placing order:", error);
    }
  }
}

// Usage
const bot = new TradingBot("your-private-key", "your-subaccount-address");
bot.start();
```

## Smart Contract Transactions

For developers who need direct access to Decibel's smart contracts, this section shows how to build and submit transactions directly using the Aptos SDK.

### Core Transaction Infrastructure

#### Base Transaction Manager

```typescript
import {
  Account,
  AccountAddress,
  AccountAuthenticator,
  Aptos,
  AptosConfig,
  CommittedTransactionResponse,
  InputGenerateTransactionPayloadData,
  MoveString,
  Network,
  PendingTransactionResponse,
  SimpleTransaction,
  createObjectAddress,
} from "@aptos-labs/ts-sdk";

class DecibelTransactionManager {
  private aptos: Aptos;
  private config: DecibelConfig;
  private skipSimulate: boolean;

  constructor(
    config: DecibelConfig,
    private account: Account,
    options?: {
      skipSimulate?: boolean;
      nodeApiKey?: string;
    },
  ) {
    this.config = config;
    this.skipSimulate = options?.skipSimulate ?? false;

    const aptosConfig = new AptosConfig({
      network: config.network,
      fullnode: config.fullnodeUrl,
      clientConfig: { API_KEY: options?.nodeApiKey },
    });
    this.aptos = new Aptos(aptosConfig);
  }

  private async getSimulatedTransaction(
    payload: InputGenerateTransactionPayloadData,
    sender: AccountAddress,
  ): Promise<SimpleTransaction> {
    const transaction = await this.aptos.transaction.build.simple({
      sender,
      data: payload,
    });

    const [simulationResult] = await this.aptos.transaction.simulate.simple({
      transaction,
      options: {
        estimateMaxGasAmount: true,
        estimateGasUnitPrice: true,
      },
    });

    if (!simulationResult?.max_gas_amount || !simulationResult?.gas_unit_price) {
      throw new Error("Transaction simulation failed - no gas estimates returned");
    }

    return await this.aptos.transaction.build.simple({
      sender,
      data: payload,
      options: {
        maxGasAmount: Number(simulationResult.max_gas_amount),
        gasUnitPrice: Number(simulationResult.gas_unit_price),
      },
    });
  }

  async sendTransaction(
    payload: InputGenerateTransactionPayloadData,
    accountOverride?: Account,
  ): Promise<CommittedTransactionResponse> {
    const signer = accountOverride ?? this.account;
    const sender = signer.accountAddress;

    let transaction: SimpleTransaction;

    if (!this.skipSimulate) {
      transaction = await this.getSimulatedTransaction(payload, sender);
    } else {
      transaction = await this.aptos.transaction.build.simple({
        sender,
        data: payload,
      });
    }

    const senderAuthenticator = this.aptos.transaction.sign({
      signer,
      transaction,
    });

    const pendingTransaction = await this.aptos.transaction.submit.simple({
      transaction,
      senderAuthenticator,
    });
    return await this.aptos.waitForTransaction({
      transactionHash: pendingTransaction.hash,
    });
  }
}
```

### Utility Functions

```typescript
/**
 * Get market address from market name
 */
function getMarketAddress(marketName: string, perpEngineGlobalAddr: string): AccountAddress {
  const marketNameBytes = new MoveString(marketName).bcsToBytes();
  return createObjectAddress(AccountAddress.fromString(perpEngineGlobalAddr), marketNameBytes);
}

/**
 * Get primary subaccount address for a user account
 */
function getPrimarySubaccountAddress(userAddress: AccountAddress): string {
  // TODO update
  const seed = new TextEncoder().encode("primary_account");
  return createObjectAddress(userAddress, seed).toString();
}

/**
 * Extract order ID from transaction events
 */
function extractOrderIdFromTransaction(
  txResponse: CommittedTransactionResponse,
  subaccountAddr: string,
): string | null {
  try {
    if ("events" in txResponse && Array.isArray(txResponse.events)) {
      for (const event of txResponse.events) {
        if (event.type.includes("::market_types::OrderEvent")) {
          const orderEvent = event.data as any;
          if (orderEvent.user === subaccountAddr) {
            return orderEvent.order_id;
          }
        }
      }
    }
    return null;
  } catch (error) {
    console.error("Error extracting order ID:", error);
    return null;
  }
}
```

### Account Management Transactions

#### Create Subaccount

```typescript
async function createSubaccount(
  transactionManager: DecibelTransactionManager,
  config: DecibelConfig,
): Promise<CommittedTransactionResponse> {
  return await transactionManager.sendTransaction({
    function: `${config.deployment.package}::dex_accounts::create_new_subaccount`,
    typeArguments: [],
    functionArguments: [],
  });
}
```

#### Deposit Collateral

```typescript
async function depositCollateral(
  transactionManager: DecibelTransactionManager,
  config: DecibelConfig,
  amount: number,
  subaccountAddr: string,
): Promise<CommittedTransactionResponse> {
  return await transactionManager.sendTransaction({
    function: `${config.deployment.package}::dex_accounts::deposit_to_subaccount_at`,
    typeArguments: [],
    functionArguments: [subaccountAddr, config.deployment.usdc, amount],
  });
}
```

#### Withdraw Collateral

```typescript
async function withdrawCollateral(
  transactionManager: DecibelTransactionManager,
  config: DecibelConfig,
  amount: number,
  subaccountAddr?: string,
): Promise<CommittedTransactionResponse> {
  const subaccount =
    subaccountAddr ?? getPrimarySubaccountAddress(transactionManager.account.accountAddress);

  return await transactionManager.sendTransaction({
    function: `${config.deployment.package}::dex_accounts::withdraw_from_cross_collateral`,
    typeArguments: [],
    functionArguments: [subaccount, config.deployment.usdc, amount],
  });
}
```

#### Configure Market Settings

```typescript
async function configureMarketSettings(
  transactionManager: DecibelTransactionManager,
  config: DecibelConfig,
  marketAddr: string,
  subaccountAddr: string,
  isCross: boolean,
  userLeverage: number,
): Promise<CommittedTransactionResponse> {
  return await transactionManager.sendTransaction({
    function: `${config.deployment.package}::dex_accounts::configure_user_settings_for_market`,
    typeArguments: [],
    functionArguments: [subaccountAddr, marketAddr, isCross, userLeverage],
  });
}
```

### Order Management Transactions

#### Place Order

```typescript
type PlaceOrderResult =
  | {
      success: true;
      orderId: string | undefined;
      transactionHash: string;
    }
  | {
      success: false;
      error: string;
    };

async function placeOrder(
  transactionManager: DecibelTransactionManager,
  config: DecibelConfig,
  params: {
    marketName: string;
    price: number;
    size: number;
    isBuy: boolean;
    timeInForce: number;
    isReduceOnly: boolean;
    clientOrderId?: string;
    stopPrice?: number;
    tpTriggerPrice?: number;
    tpLimitPrice?: number;
    slTriggerPrice?: number;
    slLimitPrice?: number;
    builderAddr?: string;
    builderFee?: number;
    subaccountAddr?: string;
    accountOverride?: Account;
  },
): Promise<PlaceOrderResult> {
  try {
    const marketAddr = getMarketAddress(params.marketName, config.deployment.perpEngineGlobal);
    const subaccountAddr =
      params.subaccountAddr ??
      getPrimarySubaccountAddress(transactionManager.account.accountAddress);

    const txResponse = await transactionManager.sendTransaction(
      {
        function: `${config.deployment.package}::dex_accounts_entry::place_order_to_subaccount`,
        typeArguments: [],
        functionArguments: [
          subaccountAddr,
          marketAddr.toString(),
          params.price,
          params.size,
          params.isBuy,
          params.timeInForce,
          params.isReduceOnly,
          params.clientOrderId,
          params.stopPrice,
          params.tpTriggerPrice,
          params.tpLimitPrice,
          params.slTriggerPrice,
          params.slLimitPrice,
          params.builderAddr,
          params.builderFee,
        ],
      },
      params.accountOverride,
    );

    const orderId = extractOrderIdFromTransaction(txResponse, subaccountAddr);

    return {
      success: true,
      orderId: orderId || undefined,
      transactionHash: txResponse.hash,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}
```

#### Cancel Order

```typescript
async function cancelOrder(
  transactionManager: DecibelTransactionManager,
  config: DecibelConfig,
  params: {
    orderId: number;
    marketName?: string;
    marketAddr?: string;
    subaccountAddr?: string;
    accountOverride?: Account;
  },
): Promise<CommittedTransactionResponse> {
  const marketAddr =
    params.marketAddr ??
    (params.marketName
      ? getMarketAddress(params.marketName, config.deployment.perpEngineGlobal).toString()
      : "");

  if (!marketAddr) {
    throw new Error("Either marketName or marketAddr must be provided");
  }

  const subaccountAddr =
    params.subaccountAddr ?? getPrimarySubaccountAddress(transactionManager.account.accountAddress);

  return await transactionManager.sendTransaction(
    {
      function: `${config.deployment.package}::dex_accounts::cancel_order_to_subaccount`,
      typeArguments: [],
      functionArguments: [subaccountAddr, params.orderId, marketAddr],
    },
    params.accountOverride,
  );
}
```

#### Place TWAP Order

```typescript
async function placeTwapOrder(
  transactionManager: DecibelTransactionManager,
  config: DecibelConfig,
  params: {
    marketName: string;
    size: number;
    isBuy: boolean;
    isReduceOnly: boolean;
    twapFrequencySeconds: number;
    twapDurationSeconds: number;
    subaccountAddr?: string;
    accountOverride?: Account;
  },
): Promise<CommittedTransactionResponse> {
  const marketAddr = getMarketAddress(params.marketName, config.deployment.perpEngineGlobal);
  const subaccountAddr =
    params.subaccountAddr ?? getPrimarySubaccountAddress(transactionManager.account.accountAddress);

  return await transactionManager.sendTransaction(
    {
      function: `${config.deployment.package}::dex_accounts::place_twap_order_to_subaccount`,
      typeArguments: [],
      functionArguments: [
        subaccountAddr,
        marketAddr.toString(),
        params.size,
        params.isBuy,
        params.isReduceOnly,
        params.twapFrequencySeconds,
        params.twapDurationSeconds,
      ],
    },
    params.accountOverride,
  );
}
```

### Position Management Transactions

#### Place TP/SL Order

```typescript
async function placeTpSlOrderForPosition(
  transactionManager: DecibelTransactionManager,
  config: DecibelConfig,
  params: {
    marketAddr: string;
    tpTriggerPrice?: number;
    tpLimitPrice?: number;
    tpSize?: number;
    slTriggerPrice?: number;
    slLimitPrice?: number;
    slSize?: number;
    subaccountAddr?: string;
    accountOverride?: Account;
  },
): Promise<CommittedTransactionResponse> {
  const subaccountAddr =
    params.subaccountAddr ?? getPrimarySubaccountAddress(transactionManager.account.accountAddress);

  return await transactionManager.sendTransaction(
    {
      function: `${config.deployment.package}::dex_accounts::place_tp_sl_order_for_position`,
      typeArguments: [],
      functionArguments: [
        subaccountAddr,
        params.marketAddr,
        params.tpTriggerPrice,
        params.tpLimitPrice,
        params.tpSize,
        params.slTriggerPrice,
        params.slLimitPrice,
        params.slSize,
      ],
    },
    params.accountOverride,
  );
}
```

### Trading Delegation

#### Delegate Trading

```typescript
async function delegateTradingToForSubaccount(
  transactionManager: DecibelTransactionManager,
  config: DecibelConfig,
  params: {
    accountToDelegateTo: string;
    subaccountAddr?: string;
  },
): Promise<CommittedTransactionResponse> {
  const subaccountAddr =
    params.subaccountAddr ?? getPrimarySubaccountAddress(transactionManager.account.accountAddress);

  return await transactionManager.sendTransaction({
    function: `${config.deployment.package}::dex_accounts::delegate_trading_to_for_subaccount`,
    typeArguments: [],
    functionArguments: [subaccountAddr, params.accountToDelegateTo],
  });
}
```

#### Revoke Delegation

```typescript
async function revokeDelegation(
  transactionManager: DecibelTransactionManager,
  config: DecibelConfig,
  params: {
    accountToRevoke: string;
    subaccountAddr?: string;
  },
): Promise<CommittedTransactionResponse> {
  const subaccountAddr =
    params.subaccountAddr ?? getPrimarySubaccountAddress(transactionManager.account.accountAddress);

  return await transactionManager.sendTransaction({
    function: `${config.deployment.package}::dex_accounts::revoke_delegation`,
    typeArguments: [],
    functionArguments: [subaccountAddr, params.accountToRevoke],
  });
}
```

### Complete Working Example

```typescript
import { Account } from "@aptos-labs/ts-sdk";

async function basicTradingExample() {
  const privateKey = "your-private-key-here";
  const account = Account.fromPrivateKey({ privateKey });
  const transactionManager = new DecibelTransactionManager(TESTNET_CONFIG, account, {
    skipSimulate: false,
  });

  try {
    // Create a subaccount
    console.log("Creating subaccount...");
    const createTx = await createSubaccount(transactionManager, TESTNET_CONFIG);
    console.log("Subaccount created:", createTx.hash);

    // Get the primary subaccount address
    const subaccountAddr = getPrimarySubaccountAddress(account.accountAddress);
    console.log("Primary subaccount address:", subaccountAddr);

    // Deposit collateral (1000 USDC = 1000000000 if 6 decimals)
    console.log("Depositing collateral...");
    const depositTx = await depositCollateral(
      transactionManager,
      TESTNET_CONFIG,
      1000000000,
      subaccountAddr,
    );
    console.log("Deposit successful:", depositTx.hash);

    // Configure market settings for BTC-USD
    const btcMarketAddr = getMarketAddress("BTC-USD", TESTNET_CONFIG.deployment.perpEngineGlobal);
    console.log("Configuring market settings...");
    const configTx = await configureMarketSettings(
      transactionManager,
      TESTNET_CONFIG,
      btcMarketAddr.toString(),
      subaccountAddr,
      true, // Use cross-margin
      1000, // 10x leverage (1000 basis points)
    );
    console.log("Market configured:", configTx.hash);

    // Place a limit buy order for 0.1 BTC at $45,000
    console.log("Placing buy order...");
    const orderResult = await placeOrder(transactionManager, TESTNET_CONFIG, {
      marketName: "BTC-USD",
      price: 45000,
      size: 0.1,
      isBuy: true,
      timeInForce: TimeInForce.GoodTillCanceled,
      isReduceOnly: false,
      subaccountAddr,
    });

    if (orderResult.success) {
      console.log("Order placed successfully!");
      console.log("Order ID:", orderResult.orderId);
      console.log("Transaction:", orderResult.transactionHash);

      // Cancel the order
      if (orderResult.orderId) {
        console.log("Canceling order...");
        const cancelTx = await cancelOrder(transactionManager, TESTNET_CONFIG, {
          orderId: parseInt(orderResult.orderId),
          marketName: "BTC-USD",
          subaccountAddr,
        });
        console.log("Order canceled:", cancelTx.hash);
      }
    } else {
      console.error("Order failed:", orderResult.error);
    }
  } catch (error) {
    console.error("Error in trading example:", error);
  }
}
```

### Best Practices

1. **Error Handling**: Always wrap transaction calls in try-catch blocks and handle different types of errors appropriately.

2. **Gas Management**: Use `skipSimulate: false` for gas estimation in production. Set appropriate gas limits for complex transactions.

3. **Subaccount Management**: Use primary subaccount for simple use cases. Create separate subaccounts for different strategies. Always verify subaccount addresses before transactions.

4. **Market Address Handling**: Cache market addresses to avoid repeated calculations. Verify market names are correct before generating addresses.

5. **Order Management**: Store order IDs for later cancellation. Use client order IDs for easier tracking. Implement proper order status monitoring.

## Resources

- 📚 [Full Documentation](https://docs.decibel.trade) - Complete API and transaction documentation
- 🔌 [REST API](https://docs.decibel.trade/api-reference/rest/overview) - REST API reference
- 🔌 [WebSocket API](https://docs.decibel.trade/api-reference/websocket/overview) - WebSocket API reference
- 💬 [Discord](https://discord.gg/decibel) - Join our community for support
- 🌐 [Trading Platform](https://app.decibel.trade) - Access the Decibel trading platform
