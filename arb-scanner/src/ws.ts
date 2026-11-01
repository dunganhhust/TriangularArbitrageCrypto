import WebSocket from "ws";
import type { Log } from "./types.js";

export interface WsOpts {
  url: string;
  /** Messages to send after every (re)connect. */
  onOpen: (send: (m: unknown) => void) => void;
  onMessage: (raw: string) => void;
  log: Log;
  pingMs?: number;
  /** Reconnect when nothing arrives for this long. */
  staleMs?: number;
}

/** WebSocket that reconnects with backoff and notices a silent connection. */
export class ReconnectingWs {
  private ws: WebSocket | null = null;
  private stopped = false;
  private tries = 0;
  private lastMsg = 0;
  private timers: NodeJS.Timeout[] = [];

  constructor(private readonly o: WsOpts) {}

  start(): void {
    this.connect();
    this.timers.push(
      setInterval(() => {
        const ws = this.ws;
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
        if (this.o.staleMs && Date.now() - this.lastMsg > this.o.staleMs) {
          this.o.log("ws silent, reconnecting", { url: this.o.url });
          ws.terminate();
        } else if (this.o.pingMs) ws.ping();
      }, this.o.pingMs ?? 15_000),
    );
  }

  stop(): void {
    this.stopped = true;
    this.timers.forEach(clearInterval);
    this.ws?.terminate();
  }

  private connect(): void {
    if (this.stopped) return;
    const ws = new WebSocket(this.o.url);
    this.ws = ws;
    ws.on("open", () => {
      this.tries = 0;
      this.lastMsg = Date.now();
      this.o.onOpen((m) => ws.send(JSON.stringify(m)));
    });
    ws.on("message", (d) => {
      this.lastMsg = Date.now();
      this.o.onMessage(d.toString());
    });
    ws.on("error", (e) => this.o.log("ws error", { url: this.o.url, error: String(e.message ?? e) }));
    ws.on("close", () => {
      if (this.stopped) return;
      const wait = Math.min(30_000, 500 * 2 ** this.tries++);
      setTimeout(() => this.connect(), wait);
    });
  }
}
