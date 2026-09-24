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
    return { accountId: engineAccountId, automatic: false, pending: 0, conflicts: [], busy: false, progress: null, lastCompleted: null, error: null };
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
