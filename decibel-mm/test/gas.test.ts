import { Ed25519Account } from "@aptos-labs/ts-sdk";
import { MAINNET_CONFIG } from "@decibeltrade/sdk";
import { describe, expect, it, vi } from "vitest";
import { MIN_SUBMIT_GAS, MMWrite, SIM_GAS_CEILING, submitGasFor } from "../src/exchange/decibel.js";

function harness(sim: unknown) {
  const write = new MMWrite(MAINNET_CONFIG, Ed25519Account.generate(), { nodeApiKey: "test" });
  const w = write as unknown as Record<string, unknown> & { aptos: { transaction: { simulate: { simple: unknown } } } };
  const buildTx = vi.spyOn(write, "buildTx").mockImplementation(async (p) => ({ built: p }) as never);
  const simulate = vi.spyOn(write.aptos.transaction.simulate, "simple").mockResolvedValue([sim] as never);
  const submit = vi.fn().mockResolvedValue({ success: true });
  w["signAndSubmit"] = submit;
  const send = (payload: unknown) => (w["sendTx"] as (p: unknown) => Promise<unknown>).call(write, payload);
  return { buildTx, simulate, submit, send };
}

describe("submitGasFor", () => {
  it("doubles usage within the floor and ceiling", () => {
    expect(submitGasFor(1500)).toBe(3000);
    expect(submitGasFor(100)).toBe(MIN_SUBMIT_GAS);
    expect(submitGasFor(10_000_000)).toBe(SIM_GAS_CEILING);
  });
});

describe("MMWrite.sendTx", () => {
  const payload = { function: "0x1::m::f", typeArguments: [], functionArguments: [] };

  it("simulates with a fixed ceiling then submits with max gas sized from real usage", async () => {
    const h = harness({ success: true, gas_used: "1500", vm_status: "Executed successfully" });
    await h.send(payload);
    expect(h.buildTx).toHaveBeenCalledTimes(2);
    expect(h.buildTx.mock.calls[0]![0]).toMatchObject({ maxGasAmount: SIM_GAS_CEILING });
    expect(h.buildTx.mock.calls[1]![0]).toMatchObject({ maxGasAmount: 3000 });
    expect(h.submit).toHaveBeenCalledTimes(1);
    expect(h.submit.mock.calls[0]![2]).toMatchObject({ encrypted: false, functionId: "0x1::m::f" });
  });

  it("throws on a failed simulation and never submits", async () => {
    const h = harness({ success: false, gas_used: "10", vm_status: "Move abort: NOT_DELEGATED" });
    await expect(h.send(payload)).rejects.toThrow("Simulation failed: Move abort: NOT_DELEGATED");
    expect(h.submit).not.toHaveBeenCalled();
  });
});
