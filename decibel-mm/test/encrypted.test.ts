import { Ed25519Account } from "@aptos-labs/ts-sdk";
import { MAINNET_CONFIG } from "@decibeltrade/sdk";
import { describe, expect, it, vi } from "vitest";

const buildTransaction = vi.fn(async (a: unknown) => ({ encryptedTx: a }));
vi.mock("@aptos-labs/ts-sdk", async (orig) => ({
  ...(await orig<typeof import("@aptos-labs/ts-sdk")>()),
  generateTransactionPayload: vi.fn(async () => ({ payload: true })),
  buildTransaction: (a: unknown) => buildTransaction(a),
}));

import { MMWrite, SIM_GAS_CEILING } from "../src/exchange/decibel.js";

type Internals = {
  canEncrypt: () => Promise<boolean>;
  signAndSubmit: (...a: unknown[]) => Promise<unknown>;
  sendEncryptedTx: (p: unknown) => Promise<unknown>;
  simulateGasUsed: (...a: unknown[]) => Promise<number>;
};

function harness(opts: { canEncrypt: boolean }) {
  const write = new MMWrite(MAINNET_CONFIG, Ed25519Account.generate(), { nodeApiKey: "t", defaultEncrypted: true });
  const w = write as unknown as Internals;
  w.canEncrypt = async () => opts.canEncrypt;
  const sim = vi.fn().mockResolvedValue(1500);
  w.simulateGasUsed = sim;
  const submit = vi.fn().mockResolvedValue({ success: true, gas_used: "1200", vm_status: "Executed successfully" });
  w.signAndSubmit = submit;
  vi.spyOn(write, "buildTx").mockImplementation(async (p) => ({ plain: p }) as never);
  return { write, w, sim, submit };
}
const payload = { function: "0x1::m::f", typeArguments: [], functionArguments: [] };

describe("encrypted submission", () => {
  it("builds the encrypted tx with an explicit max gas learned from one simulation", async () => {
    buildTransaction.mockClear();
    const h = harness({ canEncrypt: true });
    await h.w.sendEncryptedTx(payload);
    await h.w.sendEncryptedTx(payload);
    expect(h.sim).toHaveBeenCalledTimes(1); // learned once, then reused
    const opts = (buildTransaction.mock.calls[0]![0] as { options: Record<string, unknown> }).options;
    expect(opts).toMatchObject({ encrypted: true, maxGasAmount: 3000 });
    expect(typeof opts["replayProtectionNonce"]).toBe("bigint");
    expect(h.submit.mock.calls[0]![2]).toMatchObject({ encrypted: true });
    expect(h.write.lastPath).toBe("encrypted");
  });

  it("falls back to a plain simulated transaction when the node cannot encrypt", async () => {
    const h = harness({ canEncrypt: false });
    // plain path needs the real simulateGasUsed; stub the SDK client instead.
    const real = Object.getPrototypeOf(h.write).simulateGasUsed as (...a: unknown[]) => Promise<number>;
    h.w.simulateGasUsed = real.bind(h.write);
    vi.spyOn(h.write.aptos.transaction.simulate, "simple").mockResolvedValue([{ success: true, gas_used: "800", vm_status: "ok" }] as never);
    await h.w.sendEncryptedTx(payload);
    expect(h.submit.mock.calls[0]![2]).toMatchObject({ encrypted: false });
    expect(h.write.lastPath).toBe("plain");
  });

  it("stops trying encryption after repeated failures", async () => {
    const h = harness({ canEncrypt: true });
    h.submit.mockRejectedValue(new Error("boom"));
    await expect(h.w.sendEncryptedTx(payload)).rejects.toThrow("boom");
    await expect(h.w.sendEncryptedTx(payload)).rejects.toThrow("boom");
    expect(h.write.encryptionBroken).toBe(true);
    h.submit.mockResolvedValue({ success: true, gas_used: "1" });
    const real = Object.getPrototypeOf(h.write).simulateGasUsed as (...a: unknown[]) => Promise<number>;
    h.w.simulateGasUsed = real.bind(h.write);
    vi.spyOn(h.write.aptos.transaction.simulate, "simple").mockResolvedValue([{ success: true, gas_used: "10", vm_status: "ok" }] as never);
    await h.w.sendEncryptedTx(payload);
    expect(h.submit.mock.calls.at(-1)![2]).toMatchObject({ encrypted: false });
  });

  it("doubles the learned gas after an out-of-gas result", async () => {
    const h = harness({ canEncrypt: true });
    h.submit.mockResolvedValue({ success: false, gas_used: "3000", vm_status: "Out of gas" });
    await h.w.sendEncryptedTx(payload);
    expect(h.write.learnedGas.get("0x1::m::f")).toBe(Math.min(SIM_GAS_CEILING, 3000));
  });
});
