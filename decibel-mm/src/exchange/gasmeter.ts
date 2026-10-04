/** Gas actually paid, in total and per submission path, so the cost of encrypted submission can be read off the log. */

export interface PathGas {
  tx: number;
  /** Gas paid on this path, in APT. */
  gasApt: number;
  /** Gas unit price of the most recent transaction on this path, in octas. */
  unitPrice: number | null;
  /** Mean APT per transaction. */
  avgApt: number | null;
}

export interface SettledTx {
  encrypted: boolean;
  gasUsed?: number;
  gasUnitPrice?: number;
}

const OCTAS = 1e8;

export class GasMeter {
  txCount = 0;
  private octas = 0;
  private readonly paths = {
    encrypted: { tx: 0, octas: 0, unitPrice: null as number | null },
    plain: { tx: 0, octas: 0, unitPrice: null as number | null },
  };

  record(m: SettledTx): void {
    const octas = (m.gasUsed ?? 0) * (m.gasUnitPrice ?? 0);
    this.txCount++;
    this.octas += octas;
    const p = this.paths[m.encrypted ? "encrypted" : "plain"];
    p.tx++;
    p.octas += octas;
    if (m.gasUnitPrice !== undefined) p.unitPrice = m.gasUnitPrice;
  }

  get gasApt(): number {
    return this.octas / OCTAS;
  }

  byPath(): Record<"encrypted" | "plain", PathGas> {
    const out = (p: { tx: number; octas: number; unitPrice: number | null }): PathGas => ({
      tx: p.tx,
      gasApt: p.octas / OCTAS,
      unitPrice: p.unitPrice,
      avgApt: p.tx > 0 ? p.octas / OCTAS / p.tx : null,
    });
    return { encrypted: out(this.paths.encrypted), plain: out(this.paths.plain) };
  }
}
