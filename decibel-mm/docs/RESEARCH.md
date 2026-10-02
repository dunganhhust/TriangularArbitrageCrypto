# Decibel research notes

Compiled 2026-10-02 from public sources and from the published `@decibeltrade/sdk@0.8.2`
package (types, ABI JSON and source). `docs.decibel.trade` itself was not reachable from the
build sandbox, so anything marked **UNVERIFIED** must be checked against the live docs/app
before real money is used.

## What Decibel is

- Fully on-chain perpetuals exchange on Aptos: central limit order book, on-chain risk engine,
  cross-margin subaccounts, ~1s funding. Mainnet launched 2026-02-25.
  ([CoinDesk](https://www.coindesk.com/business/2026/02/25/perpetuals-exchange-decibel-goes-live-on-aptos-following-usd50-million-in-pre-deposits),
  [The Defiant](https://thedefiant.io/news/defi/decibel-perpetuals-exchange-launches-on-aptos))
- The REST/WebSocket API reads from an indexer; **orders are Aptos transactions** signed by the
  trader (or a delegate). Reads need an Aptos Build / Geomi API key, otherwise 401.
- Mainnet endpoints (from SDK `constants.js`): fullnode `https://api.mainnet.aptoslabs.com/v1`,
  REST `https://api.mainnet.aptoslabs.com/decibel`, WS `wss://api.mainnet.aptoslabs.com/decibel/ws`,
  gas station `https://api.mainnet.aptoslabs.com/gs/v1`.

## Fees (docs.decibel.trade/for-traders/fees, via search snippet)

| Tier | 30d volume | Taker | Maker |
|---|---|---|---|
| 0 | < $10M | 3.40 bps | 1.10 bps |
| 1 | > $10M | 3.00 | 0.90 |
| 2 | > $50M | 2.50 | 0.60 |
| 3 | > $200M | 2.20 | 0.30 |
| 4 | > $1B | 2.10 | 0.00 |
| 5 | > $4B | 1.90 | 0.00 |
| 6 | > $15B | 1.80 | 0.00 |

**Observed on mainnet (2026-10-02, fee tier 0, via `userFees`):** maker 0.015% (1.5 bps), taker 0.045%
(4.5 bps) — higher than the table above, so always trust the live `userFees` values the bot logs.
`npm run check` also confirmed mainnet market names use a slash (`BTC/USD`), and `perp_equity_balance`
is reported in plain USD.

Consequence: at tier 0 a maker **pays** 1.1 bps. There is no negative maker fee in this
schedule, so "rebate" income, if any, comes from campaigns (below), not the fee tier.
The bot reads the real rates per subaccount (`userFees`) at runtime and does not hard-code these.

## Points ("Amps")

Known from public pages and SDK types:

- Season 1 started March 2026. Points are credited **daily** for trading, streaks (consistent
  daily trading above some size), referrals (referrer gets 10% of referee points, additive),
  and DLP/vault deposits.
  ([Decibel points page](https://app.decibel.trade/points), [Cryptorank guide](https://cryptorank.io/drophunting/decibel-activity1006))
- Distribution reportedly weighs more than raw volume (position hold time, consistency).
- The SDK exposes read endpoints that make the programme *measurable per account*:
  `tradingAmps.getDailyByOwner` (per day: `trading_amps`, `streak_amps`, `referral_amps`, `vault_amps`),
  `streaks.getByOwner` (current streak, qualifying dates, grace days), `tier.getByOwner`,
  `pointsLeaderboard`, `globalPointsStats`.
- `campaigns` types include `maker_incentive` and `fee_rebate` — these are the likely sources of
  any maker rebate. Reward amounts are claimed with `claimCampaignReward(id)`.

**UNVERIFIED / not public:** the exact Amps-per-dollar formula, whether maker and taker volume
are weighted differently, the streak volume threshold, and any wash-trading filters.

### How the bot deals with that uncertainty

It does not guess a formula. It:

1. Maximises **maker volume per unit of realised cost** under an operator-set budget
   (`points.costBudgetBps`), using fill markouts + fees as the cost measure.
2. Chases a **daily volume target** and a **streak floor** (`dailyVolumeTargetUsd`, `streakMinVolumeUsd`)
   by tightening quotes late in the UTC day only when the cost budget allows.
3. Every 5 minutes it logs `trading_amps / day volume` to `data/points_log.csv`
   (`ampsPerMillionUsd`, alongside spread multiplier and PnL). That file is the experiment: after a
   week you can see empirically whether tighter/looser quoting or more volume changed Amps per
   dollar, and set the budget accordingly.

## On-chain order API (from the SDK ABI)

- `dex_accounts_entry::place_bulk_orders_to_subaccount(signer, subaccount, market, sequence_number: u64,
  bid_prices: vec<u64>, bid_sizes: vec<u64>, ask_prices: vec<u64>, ask_sizes: vec<u64>,
  builder: Option<address>, builder_fee: Option<u64>)` — **one transaction replaces the whole
  ladder for a market**; `sequence_number` must strictly increase. This is what the bot uses
  (the public SDK wrapper only exposes the *spot* variant, so the adapter builds the perp payload itself).
  A `…_with_repricing` variant exists; its extra `Option<u64>` is undocumented, so it is not used.
- `cancel_bulk_order_to_subaccount(signer, subaccount, market)` cancels the ladder.
- `place_order_to_subaccount` with `TimeInForce` 0=GTC, 1=PostOnly, 2=IOC is used only for
  emergency reduce-only IOC orders.
- `delegate_trading_to_for_subaccount` lets a separate hot key trade a subaccount without
  withdrawal rights. Run the bot with a **delegated key**, never the owner key.
- Reads return plain numbers; whether they are chain-scaled (`x * 10^decimals`) or human units is
  not documented in the types. The adapter detects it from the oracle price and refuses to trade
  when ambiguous (override with `live.priceUnits` / `live.sizeUnits`).

## Things to verify on testnet before mainnet

1. `npm run check` — units detected correctly, markets listed, fee rates and Amps endpoints return data for your owner address.
2. A bulk order with a crossing price: does it reject, or take? (The bot never sends one, but confirm the failure mode.)
3. Position `size` sign convention (assumed signed, long > 0).
4. Whether bulk-order fills appear in `userTradeHistory` with `source = OrderFill` (assumed yes).
5. How partial fills change the resting bulk order (the bot re-sends the full ladder after any fill, so it self-heals either way).
6. Latency: tx round-trip determines how stale a quote can be; tune `minReplaceIntervalMs` and `repriceBps` to it.
