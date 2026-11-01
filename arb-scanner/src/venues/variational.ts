import type { Book, Funding, Log, Venue, VenueFees } from "../types.js";

/**
 * Variational Omni: RFQ-style venue whose only public data is `GET /metadata/v2/stats` (indicative quotes cached up to
 * 600 s, no order book, trading API not yet public). It therefore provides FUNDING only; `book()` is always null, so it
 * never takes part in the spread scan.
 */
export function parseVariationalFunding(body: unknown, ts: number): Map<string, Funding> {
  const out = new Map<string, Funding>();
  const rows = (body as { listings?: { ticker?: string; contract_type?: string; funding?: { last?: { interval_rate?: string }; interval_seconds?: number } | null }[] })?.listings ?? [];
  for (const r of rows) {
    if (r.contract_type !== "perpetual" || !r.ticker || !r.funding?.last || !r.funding.interval_seconds) continue;
    const rate = Number(r.funding.last.interval_rate);
    if (Number.isFinite(rate)) out.set(r.ticker, { ratePerHour: rate / (r.funding.interval_seconds / 3600), ts });
  }
  return out;
}

export class Variational implements Venue {
  readonly name = "variational";
  readonly fees: VenueFees;
  samples: string[] = [];
  private fund = new Map<string, Funding>();
  private timer: NodeJS.Timeout | null = null;
  private active: string[] = [];

  constructor(
    private readonly log: Log,
    /** Omni states it charges no fees. */
    fees: VenueFees = { makerBps: 0, takerBps: 0 },
    private readonly url = "https://omni-client-api.prod.ap-northeast-1.variational.io",
  ) {
    this.fees = fees;
  }

  async start(symbols: string[]): Promise<void> {
    await this.poll();
    this.active = symbols.filter((s) => this.fund.has(`${s}-PERP`));
    // Limit: 10 requests / 10 s per IP. One request per minute is plenty for a funding rate.
    this.timer = setInterval(() => void this.poll().catch((e) => this.log("variational poll failed", { error: String(e) })), 60_000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async poll(): Promise<void> {
    const r = await fetch(this.url + "/metadata/v2/stats");
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const body = await r.json();
    if (this.samples.length < 2) this.samples.push(JSON.stringify((body as { listings?: unknown[] }).listings?.slice(0, 1)).slice(0, 600));
    for (const [k, v] of parseVariationalFunding(body, Date.now())) this.fund.set(k, v);
  }

  book(): Book | null {
    return null;
  }
  funding(symbol: string): Funding | null {
    return this.fund.get(`${symbol}-PERP`) ?? null;
  }
  symbols(): string[] {
    return this.active;
  }
}
