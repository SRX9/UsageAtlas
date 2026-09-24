import { describe, expect, it } from "vitest";
import {
  createEngineReadyMessage,
  EngineRequestError,
  isEngineProgressMessage,
  isEngineImportMessage,
  isEngineReadyMessage,
  parseEngineRequest,
  parseEngineResponse
} from "./protocol";

describe("engine protocol", () => {
  it("validates account-scoped import counts", () => {
    const message = { type: "engine.import-progress", accountId: "a", progress: { completed: 250, total: 701, error: null } };
    expect(isEngineImportMessage(message)).toBe(true);
    expect(isEngineImportMessage({ ...message, progress: null })).toBe(true);
    for (const completed of [-1, 702, 1.5, NaN, Infinity])
      expect(isEngineImportMessage({ ...message, progress: { ...message.progress, completed } })).toBe(false);
    expect(isEngineImportMessage({ ...message, accountId: null })).toBe(false);
  });

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
