import { expect, it, vi } from "vitest";

const { handle } = vi.hoisted(() => ({ handle: vi.fn() }));
vi.mock("./engine-service", () => ({ EngineService: class { handle = handle; } }));
vi.mock("./providers/registry", () => ({ createProviderAdapters: () => [] }));

it("answers cloud status while a provider refresh is still waiting", async () => {
  let receive!: (event: { data: unknown }) => void;
  const postMessage = vi.fn();
  const original = Object.getOwnPropertyDescriptor(process, "parentPort");
  Object.defineProperty(process, "parentPort", { configurable: true, value: {
    on: (_event: string, callback: typeof receive) => { receive = callback; }, postMessage
  } });
  let finish!: () => void;
  const waiting = new Promise<void>((resolve) => { finish = resolve; });
  handle.mockImplementation(async (request: { id: string }) => {
    if (request.id === "refresh") await waiting;
    return { id: request.id, ok: true, result: { busy: false }, error: null };
  });
  try {
    await import("./engine-entry");
    receive({ data: { id: "refresh", method: "provider.refresh", params: { providerID: "codex" } } });
    await Promise.resolve();
    receive({ data: { id: "status", method: "cloud", params: { operation: "status" } } });
    await vi.waitFor(() => expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ id: "status", result: { busy: false } })));
    expect(postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ id: "refresh" }));
    finish();
    await vi.waitFor(() => expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ id: "refresh" })));
  } finally {
    finish();
    if (original) Object.defineProperty(process, "parentPort", original);
    else Reflect.deleteProperty(process, "parentPort");
  }
});
