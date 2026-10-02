# decibel-mm — points- and rebate-aware market maker for Decibel (Aptos)

A two-sided maker for Decibel perpetuals. It quotes a multi-level ladder through Decibel's
on-chain **bulk order** (one transaction replaces every level), manages inventory, and tunes how
aggressively it quotes so that it buys as much maker volume (the input to Decibel Amps, streaks
and any maker campaign) as a cost budget you set allows.

> **Status:** engine, strategy, risk and simulator are tested (`npm test`, 30 tests). The live
> Decibel adapter type-checks against `@decibeltrade/sdk@0.8.2` but **has not been run against the
> network** — the build sandbox could not reach Aptos endpoints. Run `check`, then `live --dry-run`
> on testnet, then tiny size on mainnet. See [docs/RESEARCH.md](docs/RESEARCH.md) for what is and is
> not verified. This is not financial advice; you can lose money.

## How it optimises for points

The Amps formula is not publicly documented, so the bot optimises what it can measure:

| Lever | What it does |
|---|---|
| **Maker-only quoting** | Resting ladder, never crosses the touch, never quotes through its own bid/ask. Taker orders are used only for emergency inventory reduction. |
| **Cost-budget controller** (`points.costBudgetBps`) | Measures realised net PnL per $ of volume (spread capture + 5s markout − fees, EWMA). Tightens quotes while cost is under budget, widens when over. |
| **Daily volume schedule** | If today's UTC volume is behind `dailyVolumeTargetUsd × elapsed-fraction`, it pays up (within the budget) to catch up; once the streak floor is secured and the target hit it relaxes. |
| **Inventory skew + one-sided quoting** | Keeps position small so the volume is cheap; caps exposure at `maxPositionUsd`. |
| **Bulk-order refresh** | A whole ladder per tx; throttled (`minReplaceIntervalMs`, `repriceBps`) so gas and sequence numbers aren't wasted, with an immediate refresh when the market runs into the top quote. |
| **Research log** | `data/points_log.csv`: Amps vs volume vs spread multiplier vs PnL every 5 min. Use it to find the budget that maximises Amps per dollar of cost. |

It deliberately does **not** do self-trading or wash trading to inflate volume: the quoter
prevents its own bid/ask from matching, and such volume would likely be filtered or sanctioned by
the programme. Check Decibel's terms before running any volume strategy.

## Setup

```bash
cd decibel-mm
npm install
cp config.example.json config.json      # edit markets, sizes, budget
npm test && npm run typecheck
npm run paper                           # simulated venue, no network, no keys
```

Live prerequisites:

1. An Aptos Build / Geomi **API key** (reads return 401 without it).
2. A Decibel **subaccount** funded with USDC.
3. A separate **hot key** with trading delegation on that subaccount (use the SDK's
   `delegateTradingToForSubaccount`; do not use the owner key).

```bash
export APTOS_NODE_API_KEY=...     # Geomi API key
export MM_PRIVATE_KEY=0x...       # delegated hot key
export MM_SUBACCOUNT=0x...        # trading subaccount address
export MM_OWNER=0x...             # owner wallet (Amps/streak are aggregated per owner)

npm run check                     # read-only: markets, detected units, fees, Amps endpoints
npx tsx src/cli.ts live config.json --dry-run   # real data, transactions are only logged
npx tsx src/cli.ts live config.json             # trades
```

Set `"network": "testnet"` first. Stop with Ctrl-C (cancels quotes) or `touch state/KILL`
(halts and cancels).

## Config (config.json)

Market `name` must match Decibel exactly; on mainnet that is e.g. `BTC/USD` (with a slash). If it is wrong, the bot exits with the list of available names.

Per market: `maxPositionUsd`, `levelSizeUsd`, `levels`, `baseHalfSpreadBps`, `levelStepBps`,
`inventorySkewBps`, `minHalfSpreadBps`, `volK`. Global sections `points`, `risk`, `engine`, `live`,
`paper` — all defaults are in `src/config.ts`. Start small: `maxPositionUsd` of a few hundred USD.

**Size to your equity.** Positions are margined: with e.g. $20 of equity and 10x max leverage, a
`maxPositionUsd` of 500 (the example) cannot be held and risks liquidation. Keep `maxPositionUsd`
to a small multiple of equity at most, `levelSizeUsd` above the market's minimum order
(`npm run check` prints `minOrderUsd` per configured market; levels below it are silently dropped),
and set `risk.maxDrawdownUsd` to the loss you accept.

`minHalfSpreadBps` is a floor. At fee tier 0 a maker pays ~1.1 bps, so a 0.6 bps half spread
only makes sense if you are knowingly buying points; the controller will widen if measured cost
exceeds the budget, but only after it has seen `points.minSampleUsd` of volume.

## Risk controls

- Pause + cancel on: stale/empty/crossed book, wide spread, mid vs oracle divergence, tx cool-down.
- Taker reduce-only IOC when |position| > `emergencyPositionMult × maxPositionUsd`.
- Halt on drawdown (`risk.maxDrawdownUsd`) or the KILL file.
- **Resting orders live on-chain and stay there if the process dies.** There is no cancel-on-disconnect.
  Run under a supervisor, keep `maxPositionUsd` small, and know how to cancel from the Decibel UI.

## Layout

```
src/strategy/quoter.ts   pure ladder construction, replace rules, own-order stripping
src/strategy/points.ts   cost-budget / volume-schedule controller
src/strategy/risk.ts     pure risk decisions
src/engine.ts            control loop (injected clock, exchange-agnostic)
src/exchange/decibel.ts  live adapter (SDK reads + WS, bulk-order writes, Amps telemetry)
src/exchange/paper.ts    simulator for dry runs and tests
```
