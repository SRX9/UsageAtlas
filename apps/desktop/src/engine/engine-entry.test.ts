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
    receive({ data: { id: "configure", method: "cloud", params: { operation: "configure", accountId: "next-account" } } });
    await Promise.resolve();
    expect(handle).not.toHaveBeenCalledWith(expect.objectContaining({ id: "configure" }));
    finish();
    await vi.waitFor(() => expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ id: "refresh" })));
    await vi.waitFor(() => expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ id: "configure" })));
  } finally {
    finish();
    if (original) Object.defineProperty(process, "parentPort", original);
    else Reflect.deleteProperty(process, "parentPort");
  }
});
