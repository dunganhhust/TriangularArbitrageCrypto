import { Ed25519Account, Ed25519PrivateKey } from "@aptos-labs/ts-sdk";
import type { CommittedTransactionResponse, InputGenerateTransactionPayloadData } from "@aptos-labs/ts-sdk";
import {
  DecibelReadDex,
  DecibelWriteDex,
  MAINNET_CONFIG,
  TESTNET_CONFIG,
  TimeInForce,
  getMarketAddr,
} from "@decibeltrade/sdk";
import type { DecibelConfig, SendTxOpts } from "@decibeltrade/sdk";
import type { LiveEnv } from "../config.js";
import type { AccountInfo, Book, BookLevel, Fill, Ladder, MarketSpec, PointsSnapshot, PriceInfo } from "../types.js";
import type { Exchange, GasStats, ReduceRequest } from "./exchange.js";

type Units = "human" | "chain";

export interface DecibelOpts {
  network: "mainnet" | "testnet";
  env: LiveEnv;
  /** Log transactions instead of sending them. Reads and streams stay live. */
  dryRun?: boolean;
  /** Override unit auto-detection. */
  priceUnits?: Units | 'auto';
  sizeUnits?: Units | 'auto';
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}

/**
 * The SDK's REST/WS readers return plain numbers without documenting whether they are in
 * chain units (value * 10^decimals) or human units. Detect it from the oracle price and
 * tick/lot alignment; when the evidence is ambiguous return "unknown" so the caller can
 * demand an explicit override instead of trading with a 10^6 scaling error.
 */
export function detectUnits(
  samples: number[],
  chainStep: number,
  decimals: number,
  reference?: number,
): Units | "unknown" {
  const xs = samples.filter((x) => Number.isFinite(x) && x > 0);
  if (xs.length === 0) return "unknown";
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  if (reference && reference > 0 && decimals > 0) {
    const scaled = mean / reference / 10 ** decimals;
    // Reference is a human-units oracle price and the samples are scaled up: definitive.
    if (scaled > 0.2 && scaled < 5) return "chain";
  }
  const integral = xs.every((x) => Number.isInteger(x));
  const aligned = xs.every((x) => x % Math.max(chainStep, 1) === 0);
  if (!integral || !aligned) return "human";
  // Integral + aligned: chain units, unless the values are too small to be a scaled amount.
  if (mean < 10 ** decimals) return "human";
  return "unknown";
}

/** Highest max_gas_amount we will reserve while simulating (units; reserve = units * gas price). */
export const SIM_GAS_CEILING = 50_000;
/** Floor for the max_gas_amount we submit with. */
export const MIN_SUBMIT_GAS = 2_000;

/** max_gas_amount to submit with: 2x the simulated usage, within [MIN_SUBMIT_GAS, SIM_GAS_CEILING]. */
export function submitGasFor(gasUsed: number): number {
  return Math.min(SIM_GAS_CEILING, Math.max(Math.ceil(gasUsed * 2), MIN_SUBMIT_GAS));
}

type SignAndSubmit = (
  signer: unknown,
  tx: unknown,
  telemetry: { encrypted: boolean; functionId?: string },
) => Promise<CommittedTransactionResponse>;

/**
 * Subclass for (1) the perp bulk-order entry points, which the SDK only wraps for spot, and
 * (2) a self-pay `sendTx`.
 *
 * The SDK's self-pay path simulates with `estimateMaxGasAmount`, which makes the node report the
 * account's whole balance as max gas, then submits with 2x that. The fee reserve is then twice
 * the balance, so every transaction is rejected with INSUFFICIENT_BALANCE_FOR_TRANSACTION_FEE
 * whatever the balance. We simulate with a fixed ceiling instead, read the real gas used, and
 * submit with a max sized from that. A failing simulation throws before anything is paid.
 */
export class MMWrite extends DecibelWriteDex {
  protected override async sendTx(
    payload: InputGenerateTransactionPayloadData,
    { accountOverride }: SendTxOpts = {},
  ): Promise<CommittedTransactionResponse> {
    const signer = accountOverride ?? this.account;
    const sender = signer.accountAddress;
    const probe = await this.buildTx({ ...payload, maxGasAmount: SIM_GAS_CEILING }, sender);
    const [sim] = await this.aptos.transaction.simulate.simple({ transaction: probe });
    if (!sim) throw new Error("Transaction simulation returned no results");
    if (!sim.success) throw new Error(`Simulation failed: ${sim.vm_status}`);
    const tx = await this.buildTx({ ...payload, maxGasAmount: submitGasFor(Number(sim.gas_used)) }, sender);
    const functionId = "function" in payload ? String(payload.function) : undefined;
    return (this as unknown as { signAndSubmit: SignAndSubmit }).signAndSubmit(signer, tx, { encrypted: false, functionId });
  }

  async placeBulk(args: {
    marketAddr: string;
    sequenceNumber: number;
    bidPrices: number[];
    bidSizes: number[];
    askPrices: number[];
    askSizes: number[];
  }) {
    return this.sendSubaccountTx(
      (sub) =>
        this.sendTx({
          function: `${this.config.deployment.package}::dex_accounts_entry::place_bulk_orders_to_subaccount`,
          typeArguments: [],
          functionArguments: [
            sub,
            args.marketAddr,
            args.sequenceNumber,
            args.bidPrices,
            args.bidSizes,
            args.askPrices,
            args.askSizes,
            undefined, // builder address
            undefined, // builder fee
          ],
        }),
      this.subaccount,
    );
  }
  subaccount?: string;
}

export class DecibelExchange implements Exchange {
  private config: DecibelConfig;
  private read!: DecibelReadDex;
  private write!: MMWrite;
  private specs = new Map<string, MarketSpec>();
  private byAddr = new Map<string, string>(); // market addr -> name
  private books = new Map<string, Book>();
  private prices = new Map<string, PriceInfo>();
  private positions = new Map<string, number>();
  private account: AccountInfo | null = null;
  private fills: Fill[] = [];
  private seenTrades = new Set<string>();
  private unsubs: (() => void)[] = [];
  private pxUnits = new Map<string, Units>();
  private szUnits = new Map<string, Units>();
  private seq = new Map<string, number>();
  private timers: NodeJS.Timeout[] = [];
  private txCount = 0;
  private gasOctas = 0;
  private balanceApt: number | null = null;
  private makerRate = 0.00011;
  private takerRate = 0.00034;
  private readonly log: (msg: string, extra?: Record<string, unknown>) => void;

  constructor(private readonly o: DecibelOpts) {
    this.config = o.network === "mainnet" ? MAINNET_CONFIG : TESTNET_CONFIG;
    this.log = o.log ?? (() => {});
  }

  async init(marketNames: string[]): Promise<MarketSpec[]> {
    const { env } = this.o;
    const account = new Ed25519Account({ privateKey: new Ed25519PrivateKey(env.privateKey) });
    this.read = new DecibelReadDex(this.config, {
      nodeApiKey: env.nodeApiKey,
      onWsError: (e) => this.log("ws error", { error: String((e as { message?: string }).message ?? e) }),
    });
    this.write = new MMWrite(this.config, account, {
      nodeApiKey: env.nodeApiKey,
      onTransactionSettled: (m) => {
        this.txCount++;
        this.gasOctas += (m.gasUsed ?? 0) * (m.gasUnitPrice ?? 0);
      },
    });
    this.write.subaccount = env.subaccount;

    const all = await this.read.markets.getAll();
    const out: MarketSpec[] = [];
    for (const name of marketNames) {
      const m = all.find((x) => x.market_name === name);
      if (!m) throw new Error(`Market ${name} not found. Available: ${all.map((x) => x.market_name).join(", ")}`);
      if (m.mode !== "Open") throw new Error(`Market ${name} is in mode ${m.mode}`);
      const px = 10 ** m.px_decimals;
      const sz = 10 ** m.sz_decimals;
      const spec: MarketSpec = {
        name,
        addr: m.market_addr,
        pxDecimals: m.px_decimals,
        szDecimals: m.sz_decimals,
        tickSize: m.tick_size / px,
        lotSize: m.lot_size / sz,
        minSize: m.min_size / sz,
      };
      this.specs.set(name, spec);
      this.byAddr.set(m.market_addr.toLowerCase(), name);
      out.push(spec);
    }

    // Fee schedule (best effort): used to convert fills into fee USD.
    try {
      const fees = await this.read.userFees.getByAddr({ subAddr: env.subaccount });
      this.makerRate = fees.user_maker_rate;
      this.takerRate = fees.user_taker_rate;
      this.log("fees", { maker: this.makerRate, taker: this.takerRate, tier: fees.fee_tier });
    } catch (e) {
      this.log("fee lookup failed; using tier-0 defaults", { error: String(e) });
    }

    for (const name of marketNames) await this.bootstrapMarket(name);
    await this.refreshAccount();
    await this.refreshPositions();
    await this.refreshGasBalance();

    this.unsubs.push(
      this.read.userTradeHistory.subscribeByAddr(env.subaccount, (msg) => this.onTrades(msg.trades as unknown as TradeRow[])),
    );
    this.timers.push(setInterval(() => void this.refreshPositions().catch(() => {}), 1000));
    this.timers.push(setInterval(() => void this.refreshAccount().catch(() => {}), 5000));
    this.timers.push(setInterval(() => void this.refreshGasBalance().catch(() => {}), 15_000));
    return out;
  }

  private async bootstrapMarket(name: string): Promise<void> {
    const spec = this.specs.get(name)!;
    const price = await this.read.marketPrices.getByName({ marketName: name });
    const first = Array.isArray(price) ? price[0] : price;
    const ref = first?.oracle_px ?? first?.mid_px;

    // Wait for the first depth message to learn the price/size units.
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no depth update for ${name} within 15s`)), 15_000);
      const unsub = this.read.marketDepth.subscribeByName(name, 1, (d) => {
        const px = [...d.bids, ...d.asks].map((l) => l.price);
        if (!this.pxUnits.has(name)) {
          const levels = [...d.bids, ...d.asks];
          const chainTick = spec.tickSize * 10 ** spec.pxDecimals;
          const chainLot = spec.lotSize * 10 ** spec.szDecimals;
          const pu =
            this.o.priceUnits && this.o.priceUnits !== "auto"
              ? this.o.priceUnits
              : detectUnits(levels.map((l) => l.price), chainTick, spec.pxDecimals, ref);
          const su =
            this.o.sizeUnits && this.o.sizeUnits !== "auto"
              ? this.o.sizeUnits
              : detectUnits(levels.map((l) => l.size), chainLot, spec.szDecimals);
          if (pu === "unknown" || su === "unknown") {
            clearTimeout(timer);
            reject(
              new Error(
                `cannot determine units for ${name} (price=${pu}, size=${su}); sample=${JSON.stringify(levels.slice(0, 2))} oracle=${ref}. ` +
                  `Set live.priceUnits / live.sizeUnits to "human" or "chain" in the config.`,
              ),
            );
            return;
          }
          this.pxUnits.set(name, pu);
          this.szUnits.set(name, su);
          this.log("units", { market: name, price: pu, size: su, oracle: ref });
          clearTimeout(timer);
          resolve();
        }
        this.books.set(name, this.toBook(name, d.bids, d.asks, d.unix_ms));
      });
      this.unsubs.push(unsub);
    });

    this.unsubs.push(
      this.read.marketPrices.subscribeByName(name, (p) => {
        const row = (p as unknown as { price: PriceRow }).price ?? (p as unknown as PriceRow);
        this.prices.set(name, this.toPrice(name, row));
      }),
    );
    if (first) this.prices.set(name, this.toPrice(name, first as PriceRow));
  }

  private toBook(name: string, bids: BookLevel[], asks: BookLevel[], ts: number): Book {
    const ps = this.pxScale(name);
    const ss = this.szScale(name);
    const conv = (l: BookLevel): BookLevel => ({ price: l.price / ps, size: l.size / ss });
    // The wire order of depth levels is undocumented; the engine relies on best-first, so sort.
    return {
      bids: bids.map(conv).sort((a, b) => b.price - a.price),
      asks: asks.map(conv).sort((a, b) => a.price - b.price),
      ts: ts || Date.now(),
    };
  }

  private toPrice(name: string, p: PriceRow): PriceInfo {
    // Price rows share units with depth rows.
    const ps = this.pxScale(name);
    return {
      mark: p.mark_px / ps,
      mid: p.mid_px / ps,
      oracle: p.oracle_px / ps,
      fundingBps: p.is_funding_positive ? p.funding_rate_bps : -p.funding_rate_bps,
      ts: p.transaction_unix_ms || Date.now(),
    };
  }

  private pxScale(name: string): number {
    return this.pxUnits.get(name) === "chain" ? 10 ** this.specs.get(name)!.pxDecimals : 1;
  }
  private szScale(name: string): number {
    return this.szUnits.get(name) === "chain" ? 10 ** this.specs.get(name)!.szDecimals : 1;
  }

  private async refreshAccount(): Promise<void> {
    const ov = await this.read.accountOverview.getByAddr({ subAddr: this.o.env.subaccount });
    this.account = { equityUsd: ov.perp_equity_balance, ts: Date.now() };
  }

  /** The signing (hot) account pays gas in APT unless a gas station is configured. */
  private async refreshGasBalance(): Promise<void> {
    try {
      const octas = await this.write.aptos.getAccountAPTAmount({ accountAddress: this.write.account.accountAddress });
      this.balanceApt = Number(octas) / 1e8;
    } catch (e) {
      // A key that never received funds has no on-chain account yet: that is a zero balance.
      if (/not\s*found|404|does not exist/i.test(String(e))) this.balanceApt = 0;
      else this.log("gas balance lookup failed", { error: String(e).slice(0, 160) });
    }
  }

  getGas(): GasStats {
    return { txCount: this.txCount, gasApt: this.gasOctas / 1e8, balanceApt: this.balanceApt };
  }

  private async refreshPositions(): Promise<void> {
    const rows = await this.read.userPositions.getByAddr({ subAddr: this.o.env.subaccount, limit: 50 });
    const next = new Map<string, number>();
    for (const r of rows) {
      const name = this.byAddr.get(r.market.toLowerCase());
      if (!name) continue;
      next.set(name, r.size / this.szScale(name));
    }
    for (const name of this.specs.keys()) this.positions.set(name, next.get(name) ?? 0);
  }

  private onTrades(rows: TradeRow[]): void {
    for (const r of rows) {
      if (r.source !== "OrderFill" || this.seenTrades.has(r.trade_id)) continue;
      const name = this.byAddr.get(r.market.toLowerCase());
      if (!name) continue;
      this.seenTrades.add(r.trade_id);
      const side = sideOf(r.action);
      if (!side) continue;
      const price = r.price / this.pxScale(name);
      const size = r.size / this.szScale(name);
      const isMaker = !(r.client_order_id ?? "").startsWith("tk-");
      const rate = isMaker ? this.makerRate : this.takerRate;
      this.fills.push({
        id: r.trade_id,
        market: name,
        side,
        price,
        size,
        feeUsd: price * size * (r.is_rebate ? -Math.abs(rate) : rate),
        isMaker,
        ts: r.transaction_unix_ms,
      });
    }
  }

  async close(): Promise<void> {
    this.timers.forEach(clearInterval);
    this.unsubs.forEach((u) => {
      try {
        u();
      } catch {
        /* ignore */
      }
    });
  }

  getBook(m: string): Book | null {
    return this.books.get(m) ?? null;
  }
  getPrice(m: string): PriceInfo | null {
    return this.prices.get(m) ?? null;
  }
  getPosition(m: string): number {
    return this.positions.get(m) ?? 0;
  }
  getAccount(): AccountInfo | null {
    return this.account;
  }
  drainFills(): Fill[] {
    const f = this.fills;
    this.fills = [];
    return f;
  }

  private toChain(name: string, ladder: Ladder) {
    const spec = this.specs.get(name)!;
    const px = (x: number): number => Math.round(x * 10 ** spec.pxDecimals);
    const sz = (x: number): number => Math.round(x * 10 ** spec.szDecimals);
    return {
      bidPrices: ladder.bids.map((q) => px(q.price)),
      bidSizes: ladder.bids.map((q) => sz(q.size)),
      askPrices: ladder.asks.map((q) => px(q.price)),
      askSizes: ladder.asks.map((q) => sz(q.size)),
    };
  }

  /** Sequence numbers must be strictly increasing per market. */
  private nextSeq(name: string): number {
    const n = Math.max((this.seq.get(name) ?? 0) + 1, Date.now());
    this.seq.set(name, n);
    return n;
  }

  async replaceLadder(market: string, ladder: Ladder): Promise<boolean> {
    const spec = this.specs.get(market)!;
    const chain = this.toChain(market, ladder);
    const sequenceNumber = this.nextSeq(market);
    if (this.o.dryRun) {
      this.log("DRY-RUN place_bulk_orders", { market, sequenceNumber, ...chain });
      return true;
    }
    try {
      const tx = await this.write.placeBulk({ marketAddr: spec.addr, sequenceNumber, ...chain });
      const r = tx as { success?: boolean; vm_status?: string; hash?: string; gas_used?: string };
      const ok = r.success !== false;
      if (!ok) this.log("bulk order tx failed", { market, vm: r.vm_status });
      else this.log("ladder placed", { market, sequenceNumber, hash: r.hash, gasUsed: r.gas_used, bids: ladder.bids.length, asks: ladder.asks.length });
      return ok;
    } catch (e) {
      this.log("bulk order tx error", { market, error: String(e) });
      return false;
    }
  }

  async cancelAll(market: string): Promise<boolean> {
    if (this.o.dryRun) {
      this.log("DRY-RUN cancel_bulk_order", { market });
      return true;
    }
    try {
      const tx = await this.write.cancelBulkOrder({ marketName: market, subaccountAddr: this.o.env.subaccount });
      return (tx as { success?: boolean }).success !== false;
    } catch (e) {
      this.log("cancel error", { market, error: String(e) });
      return false;
    }
  }

  async reduce(req: ReduceRequest): Promise<boolean> {
    const spec = this.specs.get(req.market)!;
    const tick = spec.tickSize;
    const px = req.side === "buy" ? Math.ceil(req.limitPrice / tick) * tick : Math.floor(req.limitPrice / tick) * tick;
    const args = {
      marketName: req.market,
      price: Math.round(px * 10 ** spec.pxDecimals),
      size: Math.round(req.size * 10 ** spec.szDecimals),
      isBuy: req.side === "buy",
      timeInForce: TimeInForce.ImmediateOrCancel,
      isReduceOnly: true,
      clientOrderId: `tk-${Date.now()}`,
      subaccountAddr: this.o.env.subaccount,
    };
    if (this.o.dryRun) {
      this.log("DRY-RUN reduce", args);
      return true;
    }
    const res = await this.write.placeOrder(args);
    if (!res.success) this.log("reduce failed", { error: res.error });
    return res.success;
  }

  async getPoints(): Promise<PointsSnapshot | null> {
    const { owner, subaccount } = this.o.env;
    const snap: PointsSnapshot = {
      ampsToday: null,
      tradingAmpsToday: null,
      streakAmpsToday: null,
      currentStreak: null,
      tier: null,
      makerFeeRate: this.makerRate,
      takerFeeRate: this.takerRate,
      volume30dUsd: null,
      feeTier: null,
    };
    const [daily, streak, tier, fees, total] = await Promise.allSettled([
      this.read.tradingAmps.getDailyByOwner({ ownerAddr: owner, days: 2 }),
      this.read.streaks.getByOwner({ ownerAddr: owner }),
      this.read.tier.getByOwner({ ownerAddr: owner }),
      this.read.userFees.getByAddr({ subAddr: subaccount }),
      this.read.tradingPoints.getByOwner({ ownerAddr: owner }),
    ]);
    const names = ["tradingAmps", "streaks", "tier", "userFees", "tradingPoints"] as const;
    snap.unavailable = [daily, streak, tier, fees, total]
      .map((r, i) => (r.status === "rejected" ? `${names[i]}: ${String((r.reason as Error)?.message ?? r.reason).slice(0, 120)}` : ""))
      .filter(Boolean);
    if (daily.status === "fulfilled") {
      const today = [...daily.value.days].sort((a, b) => b.day_start_unix_ms - a.day_start_unix_ms)[0];
      if (today) {
        snap.ampsToday = today.total_amps;
        snap.tradingAmpsToday = today.trading_amps;
        snap.streakAmpsToday = today.streak_amps;
      }
    }
    if (total.status === "fulfilled") snap.totalPoints = total.value.total_points;
    if (streak.status === "fulfilled") snap.currentStreak = streak.value.currentStreak;
    if (tier.status === "fulfilled") snap.tier = tier.value.current_tier;
    if (fees.status === "fulfilled") {
      this.makerRate = fees.value.user_maker_rate;
      this.takerRate = fees.value.user_taker_rate;
      snap.makerFeeRate = this.makerRate;
      snap.takerFeeRate = this.takerRate;
      snap.feeTier = fees.value.fee_tier as unknown as number;
    }
    return snap;
  }

  /** Read-only connectivity report for the `check` command. */
  async report(): Promise<Record<string, unknown>> {
    const markets = await this.read.markets.getAll();
    return {
      network: this.o.network,
      subaccount: this.o.env.subaccount,
      // Configured markets in human units: what you need to size quotes (min order value in USD).
      configured: [...this.specs.values()].map((sp) => {
        const mid = this.prices.get(sp.name)?.mid ?? null;
        const lev = markets.find((m) => m.market_name === sp.name)?.max_leverage ?? null;
        return {
          name: sp.name,
          pxDecimals: sp.pxDecimals,
          szDecimals: sp.szDecimals,
          tickSize: sp.tickSize,
          lotSize: sp.lotSize,
          minSize: sp.minSize,
          mid,
          minOrderUsd: mid === null ? null : Number((sp.minSize * mid).toFixed(2)),
          maxLeverage: lev,
        };
      }),
      markets: markets.map((m) => ({ name: m.market_name, tick: m.tick_size, lot: m.lot_size, min: m.min_size, maxLev: m.max_leverage, mode: m.mode })),
      equity: this.account?.equityUsd,
      // Resting bulk-order ladders as the indexer sees them (human units). The web app's Open Orders
      // tab may not list bulk orders, so this is the reliable way to confirm quotes are live.
      bulkOrders: await this.read.userBulkOrders
        .getByAddr({ subAddr: this.o.env.subaccount })
        .then((rows) =>
          rows.map((r) => {
            const name = this.byAddr.get(r.market.toLowerCase()) ?? r.market;
            const ps = this.specs.has(name) ? this.pxScale(name) : 1;
            const ss = this.specs.has(name) ? this.szScale(name) : 1;
            return {
              market: name,
              sequenceNumber: r.sequence_number,
              bids: r.bid_prices.map((p, i) => ({ price: p / ps, size: (r.bid_sizes[i] ?? 0) / ss })),
              asks: r.ask_prices.map((p, i) => ({ price: p / ps, size: (r.ask_sizes[i] ?? 0) / ss })),
              cancellationReason: r.cancellation_reason ?? null,
            };
          }),
        )
        .catch((e: unknown) => ({ error: String(e).slice(0, 200) })),
      signer: { address: this.write.account.accountAddress.toString(), aptBalance: this.balanceApt, paysGas: true },
      points: await this.getPoints(),
    };
  }

  marketAddrFor(name: string): string {
    return getMarketAddr(name, this.config.deployment.perpEngineGlobal).toString();
  }
}

interface PriceRow {
  mark_px: number;
  mid_px: number;
  oracle_px: number;
  funding_rate_bps: number;
  is_funding_positive: boolean;
  transaction_unix_ms: number;
}

interface TradeRow {
  market: string;
  action: string;
  source: string;
  trade_id: string;
  size: number;
  price: number;
  is_rebate: boolean;
  client_order_id?: string;
  transaction_unix_ms: number;
}

function sideOf(action: string): "buy" | "sell" | null {
  switch (action) {
    case "Buy":
    case "OpenLong":
    case "CloseShort":
      return "buy";
    case "Sell":
    case "OpenShort":
    case "CloseLong":
      return "sell";
    default:
      return null; // "Net" is ambiguous; ignore rather than guess
  }
}
