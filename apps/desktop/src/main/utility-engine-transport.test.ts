import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createEngineReadyMessage } from "../engine/protocol";
import type { EngineTransportHandlers } from "./engine-transport";

const electron = vi.hoisted(() => ({ fork: vi.fn() }));

vi.mock("electron", () => ({ utilityProcess: { fork: electron.fork } }));

import { UtilityEngineTransport } from "./utility-engine-transport";

class FakeUtilityProcess extends EventEmitter {
  readonly stderr = new EventEmitter();
  readonly postMessage = vi.fn();
  readonly kill = vi.fn();
}

function handlers(): EngineTransportHandlers {
  return {
    message: vi.fn(),
    diagnostic: vi.fn(),
    exit: vi.fn()
  };
}

describe("UtilityEngineTransport", () => {
  beforeEach(() => {
    electron.fork.mockReset();
  });

  it("becomes ready only after the engine handshake", async () => {
    const child = new FakeUtilityProcess();
    electron.fork.mockReturnValue(child);
    const callbacks = handlers();
    const transport = new UtilityEngineTransport("engine-entry.js");

    const startup = transport.start(callbacks);
    child.emit("message", createEngineReadyMessage());
    await startup;
    child.emit("message", { id: "1", ok: true, result: {}, error: null });

    expect(callbacks.message).toHaveBeenCalledOnce();
    expect(callbacks.diagnostic).not.toHaveBeenCalled();
  });

  it("rejects a response received before the ready handshake", async () => {
    const child = new FakeUtilityProcess();
    electron.fork.mockReturnValue(child);
    const transport = new UtilityEngineTransport("engine-entry.js");

    const startup = transport.start(handlers());
    child.emit("message", { id: "1", ok: true, result: {}, error: null });

    await expect(startup).rejects.toThrow("invalid startup message");
    expect(child.kill).toHaveBeenCalledOnce();
  });

  it("kills an engine that never completes the ready handshake", async () => {
    vi.useFakeTimers();
    try {
      const child = new FakeUtilityProcess();
      electron.fork.mockReturnValue(child);
      const transport = new UtilityEngineTransport("engine-entry.js");

      const startup = transport.start(handlers());
      const rejected = expect(startup).rejects.toThrow("ready handshake timed out");
      await vi.advanceTimersByTimeAsync(10_000);

      await rejected;
      expect(child.kill).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});
