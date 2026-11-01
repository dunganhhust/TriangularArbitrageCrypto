# arb-scanner

Read-only scanner for cross-venue perp opportunities. It places **no orders** and needs no trading keys.

It answers one question with real data before any money is risked: *after fees, a latency allowance and book depth, how often
does a cross-venue edge exist, how big is it and how long does it live?*

## What it measures
- **Spread arbitrage**: buy on venue A (taking asks), sell on venue B (taking bids), both as takers, at each size in
  `notionalUsd`. Net = gross - taker fee A - taker fee B - `extraBps` (allowance for the price moving while the orders travel).
  Every opportunity is tracked until it disappears; closed ones are appended to `data/opps.jsonl` with their **duration**,
  which decides whether you could ever act on them.
- **Funding arbitrage**: long the venue with the lower funding, short the higher one. Reports carry in bps/day, APR, the
  net over `holdDays` after opening and closing both legs as takers, and the break-even holding time.

## Venues
| venue | data | status |
|---|---|---|
| Hyperliquid | public WS `l2Book`, REST `metaAndAssetCtxs` | formats known |
| Lighter | public WS `order_book/<id>`, REST `orderBooks`, `funding-rates` | **parsers unverified**: run `probe` |
| Decibel | SDK (`APTOS_NODE_API_KEY`) | reuses the bot's SDK; units detected from the oracle |
| Aster | Binance-compatible WS `<sym>@depth20@100ms`, REST `premiumIndex`, `fundingInfo` | from docs, **unverified live**; fees not in the docs: set your tier |
| Variational | REST `/metadata/v2/stats` only | **funding only**: RFQ venue, quotes cached up to 600 s, no order book, trading API not public |
| trade.xyz | Hyperliquid HIP-3 (`dex: "xyz"`), symbols like `xyz:TSLA` | off by default, unverified: needs `symbolMap` and a `probe` |

Not yet implemented, with what is known:
- **Nado**: WS `wss://api.prod.nado.xyz/gateway/v1/subscribe`, `best_bid_offer` / `book_depth` streams (subscribe message
  `{"method":"subscribe","stream":{"type":"best_bid_offer","product_id":0},"id":10}`, ping every 30 s). The event payload and
  price scaling were not in the pages read.
- **Extended**: REST `https://api.starknet.extended.exchange/api/v1`, fees maker 0 / taker 2.5 bps, hourly funding. Order-book
  stream payload not read.
- **Arcus** (docs.arcus.xyz unreachable) and **GRVT** (docs returned 403).

Adding a venue: one file in `src/venues/` implementing `Venue` (`types.ts`), registered in `cli.ts`.

## Use
```
npm install
npm test
npm run probe -- hyperliquid ETH     # raw wire samples + parsed book: verify a venue's parsers
npm run funding                      # one-off funding table
npm run scan -- --config arb.config.example.json
```
`scan` prints the best routes every 15 s and writes `data/opps.jsonl` and `data/funding.jsonl`.
On the Decibel VM run `set -a; . /etc/decibel-mm/env; set +a` first so the Decibel adapter finds its key.

## Reading the results
- Edges that appear for 1-2 scans (200 ms each) and vanish are not tradeable from a remote VM.
- A funding edge is real only if the break-even holding time is short compared with how long the rate difference lasts
  (watch `data/funding.jsonl` over days).
- Fees are config, not discovered: set each venue's real tier.
