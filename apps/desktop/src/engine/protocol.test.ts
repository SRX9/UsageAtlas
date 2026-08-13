import { describe, expect, it } from "vitest";
import {
  createEngineReadyMessage,
  EngineRequestError,
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
});
