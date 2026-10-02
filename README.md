# Decibel Market Maker

Points- and rebate-aware market maker for [Decibel](https://decibel.trade) perpetuals on Aptos.

The project lives in [`decibel-mm/`](decibel-mm/README.md):

- multi-level maker ladder via Decibel's on-chain bulk order (one transaction per refresh)
- inventory skew, one-sided quoting at the position limit, no self-crossing
- cost-budget controller that buys maker volume (Amps, streaks, maker campaigns) only while measured cost stays within budget
- risk controls: stale/crossed book, oracle divergence, emergency reduce, drawdown halt, kill file
- paper-trading simulator and a research log of Amps vs volume
- research notes in [`decibel-mm/docs/RESEARCH.md`](decibel-mm/docs/RESEARCH.md)

Quick start:

```bash
cd decibel-mm
npm install
cp config.example.json config.json
npm test && npm run paper
```

The live adapter has not been run against the network yet; follow the testnet checklist in `decibel-mm/README.md` before trading real funds.
