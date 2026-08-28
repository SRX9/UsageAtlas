import { describe, expect, it } from "vitest";
import {
  createEngineReadyMessage,
  EngineRequestError,
  isEngineProgressMessage,
  isEngineReadyMessage,
  parseEngineRequest,
  parseEngineResponse
} from "./protocol";

describe("engine protocol", () => {
  it("accepts allowlisted requests", () => {
    expect(parseEngineRequest({ id: "1", method: "snapshot.get", params: { force: true } }).method)
      .toBe("snapshot.get");
  });

  it("rejects arbitrary methods", () => {
    expect(() => parseEngineRequest({ id: "1", method: "run.command", params: {} }))
      .toThrow(EngineRequestError);
  });

  it("validates utility-process responses", () => {
    expect(parseEngineResponse({ id: "1", ok: true, result: {}, error: null }).ok).toBe(true);
    expect(() => parseEngineResponse({ id: "1", ok: true })).toThrow(EngineRequestError);
  });

  it("accepts only the exact engine-ready handshake", () => {
    expect(isEngineReadyMessage(createEngineReadyMessage())).toBe(true);
    expect(isEngineReadyMessage({ type: "engine.ready", protocolVersion: 2 })).toBe(false);
    expect(isEngineReadyMessage({ ...createEngineReadyMessage(), extra: true })).toBe(false);
  });

  it("accepts refresh progress events", () => {
    expect(isEngineProgressMessage({
      type: "engine.progress",
      completed: 1,
      total: 3,
      providerID: "claude",
      providerName: "Claude",
      status: "completed"
    })).toBe(true);
    expect(isEngineProgressMessage(createEngineReadyMessage())).toBe(false);
  });
});
