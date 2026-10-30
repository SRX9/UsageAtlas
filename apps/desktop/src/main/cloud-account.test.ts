import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EngineManager } from "./engine-manager";
import { CloudAccount } from "./cloud-account";

const files = vi.hoisted(() => ({ failRemove: false }));
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return { ...fs, unlinkSync: (filename: string) => {
    if (files.failRemove) throw new Error("EPERM: file is locked");
    fs.unlinkSync(filename);
  } };
});

const electron = vi.hoisted(() => ({
  directory: "",
  openExternal: vi.fn(),
  encryptString: vi.fn((value: string) => Buffer.from(value)),
}));
vi.mock("electron", () => ({
  app: { getPath: () => electron.directory },
  shell: { openExternal: electron.openExternal },
  safeStorage: {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => "test",
    encryptString: electron.encryptString,
    decryptString: (value: Buffer) => value.toString(),
  },
}));

let account: CloudAccount;
let cloud: ReturnType<typeof vi.fn>;
let fetchMock: ReturnType<typeof vi.fn>;
let engineAccountId: string | null;
const code = {
  device_code: "private-code",
  user_code: "ABCD-EFGH",
  expires_in: 600,
  interval: 5,
};
const response = (value: unknown, status = 200) =>
  Response.json(value, { status });

beforeEach(() => {
  vi.useFakeTimers();
  files.failRemove = false;
  electron.encryptString.mockClear();
  electron.directory = mkdtempSync(
    path.join(tmpdir(), "usageatlas-auth-test-"),
  );
  electron.openExternal.mockReset().mockResolvedValue(undefined);
  engineAccountId = null;
  cloud = vi.fn(async (params: { operation: string; accountId?: string }) => {
    if (params.operation === "configure") engineAccountId = params.accountId || null;
    return { accountId: engineAccountId, automatic: false, pending: 0, heldBack: [], heldBackCount: 0, conflicts: [], busy: false, progress: null, lastCompleted: null, error: null };
  });
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  account = new CloudAccount({ cloud } as unknown as EngineManager);
});
afterEach(() => {
  account.close();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  rmSync(electron.directory, { recursive: true, force: true });
});

describe("desktop cloud sign-in", () => {
  it("allows retry after a failed browser launch", async () => {
    fetchMock.mockImplementation(async () => response(code));
    electron.openExternal.mockRejectedValueOnce(new Error("no browser"));
    await expect(account.signIn()).rejects.toThrow(
      "Couldn't open your browser",
    );
    expect((await account.status()).loginCode).toBeNull();
    await account.signIn();
    expect((await account.status()).loginCode).toBe(code.user_code);
    expect(electron.openExternal).toHaveBeenCalledTimes(2);
  });

  it("ignores a code arriving after cancellation and prevents duplicate requests", async () => {
    let complete!: (value: Response) => void;
    fetchMock.mockReturnValue(
      new Promise<Response>((resolve) => {
        complete = resolve;
      }),
    );
    const pending = account.signIn();
    await account.signIn();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await account.signOut();
    complete(response(code));
    await pending;
    expect(electron.openExternal).not.toHaveBeenCalled();
    expect((await account.status()).loginCode).toBeNull();
  });

  it("keeps waiting until approval, then configures the engine with the verified account", async () => {
    fetchMock
      .mockResolvedValueOnce(response(code))
      .mockResolvedValueOnce(response({ error: "authorization_pending" }, 400))
      .mockResolvedValueOnce(response({ access_token: "session-token" }))
      .mockResolvedValueOnce(
        response({ user: { id: "user-a", email: "a@example.com" } }),
      );
    await account.signIn();
    await vi.advanceTimersByTimeAsync(5000);
    expect((await account.status()).loginCode).toBe(code.user_code);
    await vi.advanceTimersByTimeAsync(5000);
    expect((await account.status()).account).toEqual({
      id: "user-a",
      email: "a@example.com",
    });
    expect(cloud).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "configure",
        accountId: "user-a",
        token: "session-token",
      }),
    );
    expect((await account.status()).loginCode).toBeNull();
  });

  it("configures the dashboard only for verified sign-in, sign-out, and reconnection", async () => {
    const configure = vi.fn(async (_accountId: string, operation: () => Promise<unknown>) => operation());
    account = new CloudAccount({ cloud } as unknown as EngineManager, configure);
    fetchMock
      .mockResolvedValueOnce(response(code))
      .mockResolvedValueOnce(response({ access_token: "session-token" }))
      .mockResolvedValueOnce(response({ user: { id: "user-a", email: "a@example.com" } }));
    await account.signIn();
    expect(configure).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5000);
    expect(configure).toHaveBeenCalledExactlyOnceWith("user-a", expect.any(Function), false);
    await account.status();
    await account.operation("automatic", { enabled: false });
    expect(configure).toHaveBeenCalledOnce();
    await account.reconnect();
    expect(configure).toHaveBeenLastCalledWith("user-a", expect.any(Function), true);
    fetchMock.mockResolvedValueOnce(response({ success: true }));
    await account.signOut();
    expect(configure).toHaveBeenLastCalledWith("", expect.any(Function), false);
  });

  it("hides the previous account's sync status until the verified account is configured", async () => {
    engineAccountId = "previous-account";
    let finish!: () => void;
    const waiting = new Promise<void>(resolve => { finish = resolve; });
    account = new CloudAccount({ cloud } as unknown as EngineManager, async (_accountId, operation) => {
      await waiting;
      return operation();
    });
    fetchMock
      .mockResolvedValueOnce(response(code))
      .mockResolvedValueOnce(response({ access_token: "session-token" }))
      .mockResolvedValueOnce(response({ user: { id: "new-account", email: "a@example.com" } }));
    await account.signIn();
    await vi.advanceTimersByTimeAsync(5000);
    expect(await account.status()).toMatchObject({ account: null, accountId: null, busy: true, pending: 0, conflicts: [], loginCode: code.user_code });
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(await account.status()).toMatchObject({ account: { id: "new-account" }, accountId: "new-account", loginCode: null });
  });

  it("forwards cloud controls and disconnects the account on sign-out", async () => {
    await expect(account.operation("save")).rejects.toThrow("Sign in first");
    fetchMock
      .mockResolvedValueOnce(response(code))
      .mockResolvedValueOnce(response({ access_token: "session-token" }))
      .mockResolvedValueOnce(response({ user: { id: "user-a", email: "a@example.com" } }));
    await account.signIn();
    await vi.advanceTimersByTimeAsync(5000);
    for (const operation of ["save", "restore"] as const) {
      await account.operation(operation);
      expect(cloud).toHaveBeenLastCalledWith({ operation });
    }
    for (const enabled of [false, true]) {
      await account.operation("automatic", { enabled });
      expect(cloud).toHaveBeenLastCalledWith({ operation: "automatic", enabled });
    }
    for (const choice of ["local", "cloud"] as const) {
      await account.operation("resolve", { recordId: "record", choice });
      expect(cloud).toHaveBeenLastCalledWith({ operation: "resolve", recordId: "record", choice });
    }
    fetchMock.mockResolvedValueOnce(response({ success: true }));
    await account.signOut();
    expect(cloud).toHaveBeenLastCalledWith(expect.objectContaining({ operation: "configure", accountId: "", token: "" }));
    expect((await account.status()).account).toBeNull();
    await expect(account.operation("restore")).rejects.toThrow("Sign in first");
  });

  it("disconnects and revokes the session even when its saved file cannot be removed", async () => {
    fetchMock
      .mockResolvedValueOnce(response(code))
      .mockResolvedValueOnce(response({ access_token: "session-token" }))
      .mockResolvedValueOnce(response({ user: { id: "user-a", email: "a@example.com" } }));
    await account.signIn();
    await vi.advanceTimersByTimeAsync(5000);
    files.failRemove = true;
    fetchMock.mockResolvedValueOnce(response({ success: true }));
    await expect(account.signOut()).rejects.toThrow("saved sign-in");
    expect(cloud).toHaveBeenLastCalledWith(expect.objectContaining({ operation: "configure", accountId: "", token: "" }));
    expect(fetchMock).toHaveBeenLastCalledWith(expect.stringContaining("/api/auth/sign-out"), expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer session-token" }) }));
    expect(await account.status()).toMatchObject({ account: null, automatic: false, busy: false, error: expect.stringContaining("saved sign-in") });
  });

  it.each([
    ["expired_token", "Sign-in expired"],
    ["access_denied", "cancelled in your browser"],
  ])("explains %s and allows a fresh sign-in", async (error, message) => {
    fetchMock
      .mockResolvedValueOnce(response(code))
      .mockResolvedValueOnce(response({ error }, 400));
    await account.signIn();
    await vi.advanceTimersByTimeAsync(5000);
    expect((await account.status()).error).toContain(message);
    expect((await account.status()).loginCode).toBeNull();
  });

  it("does not sign in when an in-flight token arrives after cancellation", async () => {
    let complete!: (value: Response) => void;
    fetchMock.mockResolvedValueOnce(response(code)).mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        complete = resolve;
      }),
    );
    await account.signIn();
    await vi.advanceTimersByTimeAsync(5000);
    await account.signOut();
    complete(response({ access_token: "late-token" }));
    await vi.advanceTimersByTimeAsync(0);
    expect((await account.status()).account).toBeNull();
    expect(electron.encryptString).not.toHaveBeenCalled();
  });
});

describe("desktop profile status", () => {
  function routes(profile: () => Response | Promise<Response>, userId = "user-a") {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith("/api/auth/device/code")) return response(code);
      if (url.endsWith("/api/auth/device/token")) return response({ access_token: `token-${userId}` });
      if (url.endsWith("/api/auth/get-session")) return response({ user: { id: userId, email: `${userId}@example.com` } });
      if (url.endsWith("/api/desktop/profile")) return profile();
      if (url.includes("/api/handles/")) return response({ available: false });
      if (url.endsWith("/api/auth/sign-out")) return response({ success: true });
      throw new Error(`Unexpected request ${url}`);
    });
  }
  async function signIn() {
    await account.signIn();
    await vi.advanceTimersByTimeAsync(5000);
  }
  const profileCalls = () => fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/api/desktop/profile"));

  it("checks handles with the bearer token once signed in, so private profiles count", async () => {
    routes(() => response({ profile: null }));
    await signIn();
    await expect(account.handleAvailable("alice")).resolves.toBe(false);
    const [, init] = fetchMock.mock.calls.find(([url]) => String(url).includes("/api/handles/"))!;
    expect(init).toMatchObject({ method: "GET", headers: { Authorization: "Bearer token-user-a" } });
  });

  it("reports signed-out without asking the website", async () => {
    await account.refreshProfile();
    expect((await account.status()).profile).toEqual({ state: "signed-out" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("checks with the bearer token after sign-in and reports each answer", async () => {
    const onProfile = vi.fn();
    account = new CloudAccount({ cloud } as unknown as EngineManager, undefined, onProfile);
    let profile: unknown = null;
    routes(() => response({ profile }));
    await signIn();
    expect((await account.status()).profile).toEqual({ state: "missing" });
    const [, init] = profileCalls()[0];
    expect(init).toMatchObject({ method: "GET", headers: { Authorization: "Bearer token-user-a" } });
    profile = { handle: "alice", isPublic: false };
    await account.refreshProfile();
    expect((await account.status()).profile).toEqual({ state: "private", handle: "alice" });
    profile = { handle: "alice", isPublic: true };
    await account.refreshProfile();
    expect((await account.status()).profile).toEqual({ state: "public", handle: "alice" });
    expect(onProfile.mock.calls).toEqual([
      ["user-a", { state: "missing" }],
      ["user-a", { state: "private", handle: "alice" }],
      ["user-a", { state: "public", handle: "alice" }],
    ]);
  });

  it("stays unknown on failures and invalid answers, and keeps the last good answer", async () => {
    let reply: () => Response = () => response({ error: "Not found." }, 404);
    routes(() => reply());
    await signIn();
    expect((await account.status()).profile).toEqual({ state: "unknown" });
    reply = () => new Response("<html>old website</html>");
    await account.refreshProfile();
    reply = () => response({ profile: { handle: "Not A Handle", isPublic: true } });
    await account.refreshProfile();
    reply = () => response({});
    await account.refreshProfile();
    expect((await account.status()).profile).toEqual({ state: "unknown" });
    reply = () => response({ profile: { handle: "alice", isPublic: true } });
    await account.refreshProfile();
    reply = () => response({ error: "Cloud request failed. Try again." }, 500);
    await account.refreshProfile();
    expect((await account.status()).profile).toEqual({ state: "public", handle: "alice" });
  });

  it("shares one check at a time and drops an answer that arrives after sign-out", async () => {
    let finish!: (value: Response) => void;
    let pending = false;
    routes(() => pending ? new Promise<Response>(resolve => { finish = resolve; }) : response({ profile: null }));
    await signIn();
    pending = true;
    const first = account.refreshProfile();
    const second = account.refreshProfile();
    expect(profileCalls()).toHaveLength(2);
    await account.signOut();
    finish(response({ profile: { handle: "alice", isPublic: true } }));
    await Promise.all([first, second]);
    expect((await account.status()).profile).toEqual({ state: "signed-out" });
  });

  it("does not show one account's profile to the next account", async () => {
    routes(() => response({ profile: { handle: "alice", isPublic: true } }));
    await signIn();
    expect((await account.status()).profile).toEqual({ state: "public", handle: "alice" });
    await account.signOut();
    routes(() => new Response("unavailable", { status: 503 }), "user-b");
    await signIn();
    expect((await account.status()).profile).toEqual({ state: "unknown" });
  });
});

describe("handle availability", () => {
  it("asks the website without a token, even when signed out", async () => {
    fetchMock.mockResolvedValueOnce(response({ available: true })).mockResolvedValueOnce(response({ available: false }));
    await expect(account.handleAvailable("ada_l")).resolves.toBe(true);
    await expect(account.handleAvailable("alice")).resolves.toBe(false);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toMatch(/\/api\/handles\/ada_l$/u);
    expect(init).toMatchObject({ method: "GET" });
    expect(init.headers).not.toHaveProperty("Authorization");
  });

  it("never sends a handle the website would refuse, and rejects odd answers", async () => {
    for (const handle of ["Ada", "a", "../profile", "ada/../../x"])
      await expect(account.handleAvailable(handle)).rejects.toThrow("Invalid handle.");
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockResolvedValueOnce(response({ available: "yes" }));
    await expect(account.handleAvailable("ada_l")).rejects.toThrow("Invalid handle response.");
  });
});
