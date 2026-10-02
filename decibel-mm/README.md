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

Set `"network": "testnet"` first. Stop with Ctrl-C or SIGTERM (cancels quotes, keeps positions) or `touch state/KILL`
(halts and cancels, keeps positions). To stop **and close positions**, see "Run for a set time" below.

## Dashboard (read-only, localhost)

A live run writes two files the dashboard reads:

- `data/run.log` (`engine.runLogFile`): every log line, a `status` line every 30 s. History, fills, transactions, events.
- `data/live.json` (`engine.liveFile`, `engine.liveEveryMs`, default 1000): the latest state, replaced atomically
  every second: equity, gas, and per market the mid, best bid/ask, position, the quotes the bot has resting, and the fuse.

```bash
npm run dashboard                         # or: node --import tsx src/cli.ts dashboard config.json --port 8787
# open http://localhost:8787
```

The page polls every second. The toolbar sets a **time window** (5 min, 15 min, 1 h, 6 h, 24 h, whole run, or any number of
minutes) and a **market** filter; both apply to the fills, transactions and events tables, the charts, the per-market
cards and the economics table (the economics are always account-wide, the market filter does not change them). The APT
price in the header is fetched every 2 s from public endpoints (Coinbase, then Kraken, Binance, CoinGecko; a failing source
is skipped for 30 s) and used to turn gas into dollars; tick "giá APT tự động" off to type a price instead.

It shows the run state (running / stale / stopped / halted, dry-run or live), equity and drawdown against the stop limit,
volume and maker share, the half-month rebate ratio against the 80 % line, one card per market, gas and APT runway, fuse
and ramp state, and alerts: a silent bot (with `live.json` that is noticed after 15 s, without it after 2 min; the process
may have died while orders are still on-chain), taker fills, low APT, an open fuse. With an older bot that does not write
`live.json` the page falls back to the 30 s `status` lines.

It has no login and cannot control the bot, so it only listens on `127.0.0.1`. To see a VM's dashboard from
your own machine, tunnel the port: `gcloud compute ssh <vm> --zone <zone> -- -L 8787:localhost:8787`, then
open `http://localhost:8787` (in Cloud Shell use `-L 8080:localhost:8787` and the Web Preview on port 8080).
Only the latest run (everything after the last `market maker started` line) is shown.

## Run for a set time, then close everything

```bash
node --import tsx src/cli.ts live config.json --minutes 120      # ends by itself after 2 hours
node --import tsx src/cli.ts flatten config.json --dry-run       # what would be closed right now (one attempt, no orders sent)
node --import tsx src/cli.ts flatten config.json                 # pull quotes and close every position now
touch state/STOP                                                  # ends a running bot the same way as the deadline
```

When the deadline passes (or `state/STOP` appears) the bot stops quoting, cancels its resting orders and closes every
open position with **reduce-only IOC** orders, one market after another. Each retry widens the limit price beyond the touch
(10, 30, 60, 100, 200 bps) and waits for the position reading to change; a reduce-only order can never open or flip a
position, so a retry while the reading lags is safe. It then logs `run finished` with `flat: true/false`, removes the STOP
file and exits (code 0 if flat, 3 if something could not be closed). Things to know:

- Closing costs the **taker** fee (4.5 bps at tier 0) on the position, and counts as taker volume for the half-month
  maker ratio. On a small position that is cents.
- A position **below the market's minimum order size** (dust) cannot be closed with a normal order; it is reported as
  `dust`, not as a failure.
- If the venue never fills (no depth, an error), the result is `flat: false` with the remaining position and an error in
  the log; the dashboard shows it in red. Close it by hand in the app.
- `Ctrl+C` / `SIGTERM` still mean "cancel quotes, keep positions". During a close-out they are ignored once; send twice
  to abort. A halt (drawdown, fuse limit, `state/KILL`) also keeps positions open, as before.
- The reduce-only path has only been exercised in the simulator. **Try `flatten` on a tiny position first.**

### Start and End buttons

```bash
node --import tsx src/cli.ts dashboard config.json --control --env-file /etc/decibel-mm/env
cat state/dashboard.token        # paste into the "Mã điều khiển" box on the page
```

With `--control` the page gets a panel: run time in minutes (presets 30 min to 24 h), a dry-run tick, **Bắt đầu**,
and **Kết thúc & đóng vị thế**, plus a countdown to the deadline. Start launches
`live config.json --minutes N` as a detached child (`bash` sources the key file for the child only, so the dashboard
process never holds the private key; the child keeps running if the dashboard restarts). End writes `state/STOP`, so it
also works for a bot started by hand. Safety of the buttons:

- Off unless you pass `--control`; without it the server rejects every POST.
- Every request needs the secret in `state/dashboard.token` (created on first use, mode 0600) in an `x-mm-token`
  header, which another web page cannot send or guess; five wrong tries lock it for a minute.
- The server only listens on `127.0.0.1`. Anyone who can reach that port through your tunnel **and** read the token file
  can start and stop trading, so treat the token like a key.
- Start is refused while a bot is running (seen via its pid file or a fresh `live.json`), while `state/KILL` exists, or
  if the key file or config is missing or invalid.

## Several markets

`markets` is a list; every entry is quoted by the same loop with its own ladder, position cap, fuse and ramp-scaled
size. Account-level limits are shared: drawdown stop, gas budget, ramp stage and the toxic-flow check (poor markouts on
recent fills trip the fuse of every market, not only the one that was hit). Two things to plan for:

- **Gas scales with the number of markets**: each market's ladder replacement is its own transaction, so two markets at the
  same refresh interval cost twice the gas. On a small account lengthen `engine.minReplaceIntervalMs`.
- **Minimum order size**: a market whose minimum order (see `minOrderUsd` in `npm run check`) is larger than
  `levelSizeUsd` x the current ramp multiplier will not quote at all (the bot logs `ramp stage too small` and the dashboard
  shows "chưa báo giá"). BTC's minimum in USD is several times ETH's, so size its levels accordingly.

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

## Fee rebate is the main goal

**The Maker Rebate campaign** (docs page "Maker Rebate", app: Rewards): accounts with a maker ratio of at least
**80 %** over a half-month cycle (1st-15th, 16th-end) receive **0.5 bps** on their **bulk-order** maker fill volume,
paid on top of the standard fee after the cycle ends. Spot maker volume counts double; perp and spot qualify
separately; cap 25,000 USD per month. This bot places only bulk orders and is ~100 % maker, so it fits the rule.

What that is worth, honestly: at fee tier 0 the maker fee is 1.5 bps, so the rebate brings the cost to **1.0 bps**,
not below zero. Net maker fee goes negative only at the higher volume tiers (0.4 bps at 25 M USD / 30 d and a
free maker side from 100 M USD / 30 d). In dollars it is tiny at small size (0.5 bps of 30,000 USD = 0.15 USD).
The bot therefore treats 1.0 bps as the fixed cost to beat and relies on spread capture for the rest.

What the bot does for it:

- tracks the **cycle maker ratio** (`status.cycleMakerRatio`, `rebateEligible`, `projectedRebateUsd`; also in
  `data/points_log.csv`) and persists it across restarts;
- **holds back taker reduces** while the ratio is within `rebate.ratioBuffer` of the 80 % line (the one-sided
  quotes keep working the position down as a maker) unless the position is far past the emergency line;
- judges every fill maker or taker from the fee actually charged, so an order that crossed the book is logged
  as `taker fill`;
- subtracts the expected rebate from the maker fee when deciding whether sitting at the touch is affordable;
- records earned/ready rebate amounts from the campaign summary (`rebateEarnedUsd`, `rebateReadyUsd`) and logs
  when something is ready to claim. **Claiming is manual** (Rewards in the app).

Other fee levers: volume tiers, referral discount, and `npm run check` prints the fee ladder, active campaigns
and your campaign history (`fees`, `campaigns`).

## Protection against fast markets, front-running and bigger bots

| Feature | What it does | Config |
|---|---|---|
| **Volatility fuse** | Pulls every quote when the price range exceeds 15 bps in 5 s (or 40 bps in 60 s), the book spread blows out, the book diverges from the oracle, or 5 recent fills averaged -3 bps of markout (toxic flow). Pauses 60 s, doubling on each repeat (max 30 min), then quotes 2x wider narrowing back over 5 min; stops for good after 6 trips in an hour. | `fuse` |
| **Staged ramp** | Starts at a fraction of the configured sizes (which are the FINAL sizes). Moves up a stage only after 4 h with 20+ fills, no fuse trips and equity not down; a stage that loses 3 % steps back down, or halts at the first stage. | `ramp` |
| **Anti-stale / anti-pick-off** | Re-quotes at once (rate-limited) when the best bid/ask target moved 6 bps, instead of waiting for the slow schedule; refresh interval is randomised +/-20 % so the cadence is not predictable. | `engine.urgentRepriceBps`, `engine.jitterPct` |
| **Encrypted submission** | Orders go out as encrypted pending transactions when the node supports it, so nobody watching the mempool sees them. Falls back to plain submission automatically. `check` prints `execution.willEncrypt`. | `execution.encrypted` |
| **Touch competition** | Rests at the best bid/ask instead of behind it when that costs no more than `points.costBudgetBps` after the maker fee, and never on the side that would add to inventory you are already leaning on. | `competition`, `points.costBudgetBps` |
| **Gas budget** | Stops quoting for the rest of the UTC day after `risk.maxGasAptPerDay` APT of gas. | `risk` |

Limits, stated plainly:

- **A gap cannot be fenced.** If the price jumps 1 % between two ticks, resting quotes are hit at the old price before any software can react. The fuse stops the *aftermath* (repeated hits during a volatile regime); the only protection against the gap itself is a small position relative to equity. In the simulator a 15-minute burst of 25x volatility cost -3.2 USD on average with the fuse and -11.7 USD without (8 seeds, 1000 USD paper equity, 100 USD max position) — a simulation, not a forecast.
- **Competition is expensive at tier-0 fees.** With a 1.5 bp maker fee and BTC spreads of a tenth of a bp, sitting at the touch costs about 1.5 bp per fill. The default budget (0.3 bp) therefore keeps the bot behind the touch on BTC; raise `points.costBudgetBps` only if you have decided what a point is worth to you.
- **Encryption is unverified on mainnet.** It depends on the node advertising an encryption key; check `execution` in the `check` output.

## Gas (read this before going live)

Every ladder replacement and cancel is an Aptos transaction. The bot does not configure a gas station,
so **the signing (hot) key pays gas in APT** and must hold some. Cost per transaction is unmeasured here,
and the simulator showed roughly 1 transaction per few seconds, so gas can easily exceed the profit of a
small account. The bot therefore:

- caps the rate (`engine.minReplaceIntervalMs`, `engine.hardMinReplaceIntervalMs`, `engine.repriceBps`);
- logs `txCount`, `gasApt` (spent this run) and `signerAptBalance` in every `status` line;
- halts and cancels quotes when the signer balance drops below `risk.minGasBalanceApt`, while it can
  still pay for the cancel. If a key runs out of APT completely, resting orders cannot be cancelled by the bot.

First live run: fund the hot key with a small amount of APT, trade tiny size for ~10 minutes, then read
`gasApt / txCount` from the logs and compare per-day gas against your expected volume income.

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
src/dashboard/           read-only localhost page over data/run.log + data/live.json (analyze.ts, tail.ts, price.ts, server.ts, index.html)
```
