import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { app, autoUpdater, net } from "electron";
import { configureAutoUpdates } from "./updates";

vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    app: Object.assign(new EventEmitter(), { isPackaged: true, getVersion: () => "0.2.11" }),
    autoUpdater: Object.assign(new EventEmitter(), {
      setFeedURL: vi.fn(), checkForUpdates: vi.fn(), quitAndInstall: vi.fn()
    }),
    net: { fetch: vi.fn() }
  };
});

const platform = process.platform;
const argv = [...process.argv];

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  vi.stubEnv("USAGEATLAS_SMOKE_TEST", "0");
  Object.defineProperty(process, "platform", { value: "win32" });
  Object.assign(app, { isPackaged: true });
  autoUpdater.removeAllListeners();
  app.removeAllListeners();
  vi.mocked(autoUpdater.checkForUpdates).mockReset();
  vi.mocked(net.fetch).mockReset();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  Object.defineProperty(process, "platform", { value: platform });
  process.argv = [...argv];
});

describe("desktop updates", () => {
  it("reports current only after the updater confirms there is no update", async () => {
    const onStateChange = vi.fn();
    const updater = configureAutoUpdates({ onStateChange });
    expect(updater.getState().status).toBe("idle");
    expect((await updater.check()).status).toBe("checking");
    autoUpdater.emit("update-not-available");
    expect(updater.getState()).toMatchObject({ status: "current", currentVersion: "0.2.11" });
    expect(onStateChange.mock.lastCall?.[0].status).toBe("current");
  });

  it("deduplicates checks and waits for the user to install a staged update", async () => {
    const onUpdateReady = vi.fn();
    const updater = configureAutoUpdates({ onUpdateReady });
    await Promise.all([updater.check(), updater.check()]);
    autoUpdater.emit("update-available");
    expect(updater.getState().status).toBe("downloading");
    await updater.check();
    autoUpdater.emit("update-downloaded", {}, "", "0.2.12");
    expect(updater.getState()).toMatchObject({ status: "ready", availableVersion: "0.2.12" });
    await updater.check();
    await vi.advanceTimersByTimeAsync(7 * 60 * 60 * 1_000);
    expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled();
    onUpdateReady.mock.calls[0][0]();
    expect(autoUpdater.quitAndInstall).toHaveBeenCalledTimes(1);
  });

  it("reports updater errors and allows another manual check", async () => {
    const updater = configureAutoUpdates();
    await updater.check();
    autoUpdater.emit("error", new Error("Connection failed at https://updates.usageatlas.com/private"));
    expect(updater.getState().status).toBe("error");
    expect(updater.getState().error).toContain("try again");
    expect(updater.getState().error).not.toContain("https:");
    expect((await updater.check()).status).toBe("checking");
    expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(2);
  });

  it("handles synchronous check failures without claiming the app is current", async () => {
    vi.mocked(autoUpdater.checkForUpdates).mockImplementationOnce(() => { throw new Error("Not installed"); });
    const updater = configureAutoUpdates();
    expect((await updater.check()).status).toBe("error");
    expect((await updater.check()).status).toBe("checking");
  });

  it("keeps development and smoke-test builds out of the updater", async () => {
    Object.assign(app, { isPackaged: false });
    expect((await configureAutoUpdates().check()).status).toBe("unavailable");
    Object.assign(app, { isPackaged: true });
    vi.stubEnv("USAGEATLAS_SMOKE_TEST", "1");
    expect((await configureAutoUpdates().check()).status).toBe("unavailable");
    expect(autoUpdater.checkForUpdates).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("waits for the first-install lock, then checks automatically", async () => {
    process.argv.push("--squirrel-firstrun");
    const updater = configureAutoUpdates();
    expect((await updater.check()).status).toBe("error");
    expect(autoUpdater.checkForUpdates).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(updater.getState().status).toBe("checking");
  });

  it("uses the versioned macOS feed and offers installation only after download", async () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    const onUpdateReady = vi.fn();
    const updater = configureAutoUpdates({ onUpdateReady });
    await updater.check();
    expect(autoUpdater.setFeedURL).toHaveBeenCalledWith({ url: `https://updates.usageatlas.com/darwin/${process.arch}/0.2.11` });
    autoUpdater.emit("update-available");
    expect(onUpdateReady).not.toHaveBeenCalled();
    autoUpdater.emit("update-downloaded", {}, "", "0.2.12");
    expect(onUpdateReady).toHaveBeenCalledTimes(1);
  });

  it("reports Linux releases for manual download without calling Squirrel", async () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    vi.mocked(net.fetch).mockResolvedValue(new Response(JSON.stringify({ version: "0.2.12" })));
    const updater = configureAutoUpdates();
    expect(await updater.check()).toMatchObject({ status: "available", availableVersion: "0.2.12" });
    expect(autoUpdater.checkForUpdates).not.toHaveBeenCalled();
    vi.mocked(net.fetch).mockResolvedValue(new Response(JSON.stringify({ version: "0.2.11" })));
    expect((await updater.check()).status).toBe("current");
  });

  it.each([
    new Response("Unavailable", { status: 503 }),
    new Response(JSON.stringify({ version: "invalid" }))
  ])("treats invalid release responses as errors", async response => {
    Object.defineProperty(process, "platform", { value: "linux" });
    vi.mocked(net.fetch).mockResolvedValue(response);
    expect((await configureAutoUpdates().check()).status).toBe("error");
  });
});
