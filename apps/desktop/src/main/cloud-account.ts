import { app, safeStorage, shell } from "electron";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import path from "node:path";
import type { EngineManager } from "./engine-manager";
import type { CloudStatus, UsageCloudState } from "../shared/desktop-api";

declare const USAGEATLAS_CLOUD_URL: string;
const BASE_URL =
  typeof USAGEATLAS_CLOUD_URL === "string"
    ? USAGEATLAS_CLOUD_URL
    : "https://usageatlas.com";
interface Session {
  token: string;
  user: { id: string; email: string };
}
interface DeviceLogin {
  deviceCode: string;
  userCode: string;
  expires: number;
  interval: number;
}

export class CloudAccount {
  private session: Session | null = null;
  private login: DeviceLogin | null = null;
  private loginAttempt: object | null = null;
  private timer: NodeJS.Timeout | null = null;
  private error: string | null = null;
  private readonly filename = path.join(
    app.getPath("userData"),
    "cloud-session.enc",
  );
  constructor(
    private readonly engine: EngineManager,
    private readonly changed: () => void,
  ) {}
  async initialize(): Promise<void> {
    try {
      if (existsSync(this.filename) && safeStorage.isEncryptionAvailable()) {
        const value = JSON.parse(
          safeStorage.decryptString(readFileSync(this.filename)),
        ) as Session;
        if (
          typeof value.token === "string" &&
          typeof value.user?.id === "string" &&
          typeof value.user.email === "string"
        )
          this.session = value;
      }
    } catch {
      this.error = "Your saved sign-in could not be opened. Sign in again.";
    }
    await this.configure();
  }
  async status(): Promise<CloudStatus> {
    const state = (await this.engine.cloud({
      operation: "status",
    })) as unknown as UsageCloudState;
    return {
      ...state,
      account: this.session?.user ?? null,
      loginCode: this.login?.userCode ?? null,
      error: this.error ?? state.error,
    };
  }
  async signIn(): Promise<void> {
    if (this.login || this.loginAttempt) return;
    const url = new URL(BASE_URL);
    if (
      url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        ["localhost", "127.0.0.1"].includes(url.hostname)
      )
    )
      throw new Error("Cloud sign-in requires HTTPS.");
    if (
      !safeStorage.isEncryptionAvailable() ||
      (process.platform === "linux" &&
        safeStorage.getSelectedStorageBackend() === "basic_text")
    )
      throw new Error(
        "Unlock your system keyring to save your sign-in securely.",
      );
    this.error = null;
    const attempt = {};
    this.loginAttempt = attempt;
    try {
      const response = await this.request("/api/auth/device/code", {
        client_id: "usageatlas-desktop",
      });
      if (this.loginAttempt !== attempt) return;
      if (
        typeof response.device_code !== "string" ||
        !response.device_code ||
        typeof response.user_code !== "string" ||
        !response.user_code ||
        typeof response.expires_in !== "number" ||
        !Number.isFinite(response.expires_in) ||
        response.expires_in <= 0 ||
        typeof response.interval !== "number" ||
        !Number.isFinite(response.interval) ||
        response.interval <= 0
      )
        throw new Error("Invalid sign-in response.");
      this.login = {
        deviceCode: response.device_code,
        userCode: response.user_code,
        expires: Date.now() + Math.min(response.expires_in, 600) * 1000,
        interval: Math.max(5, response.interval) * 1000,
      };
      try {
        await shell.openExternal(
          `${BASE_URL}/account/device?user_code=${encodeURIComponent(this.login.userCode)}`,
        );
      } catch {
        throw new Error("Couldn't open your browser. Try signing in again.");
      }
      if (this.loginAttempt !== attempt) return;
      this.schedulePoll();
      this.changed();
    } catch (error) {
      if (this.loginAttempt !== attempt) return;
      this.cancelLogin();
      throw error;
    } finally {
      if (this.loginAttempt === attempt) this.loginAttempt = null;
    }
  }

  async signOut(): Promise<void> {
    this.cancelLogin();
    const session = this.session;
    this.session = null;
    this.error = null;
    if (existsSync(this.filename)) unlinkSync(this.filename);
    await this.configure();
    if (session)
      await this.request("/api/auth/sign-out", {}, session.token).catch(
        () => undefined,
      );
    this.changed();
  }
  async operation(
    operation: "save" | "restore" | "automatic" | "resolve",
    values: {
      enabled?: boolean;
      recordId?: string;
      choice?: "local" | "cloud";
    } = {},
  ): Promise<void> {
    if (!this.session) throw new Error("Sign in first.");
    this.error = null;
    await this.engine.cloud({ operation, ...values });
    this.changed();
  }
  close(): void {
    this.cancelLogin();
  }
  async reconnect(): Promise<void> {
    await this.configure();
  }
  private configure(): Promise<unknown> {
    return this.engine.cloud({
      operation: "configure",
      accountId: this.session?.user.id ?? "",
      token: this.session?.token ?? "",
      baseURL: BASE_URL,
    });
  }
  private schedulePoll(): void {
    if (!this.login) return;
    this.timer = setTimeout(() => void this.poll(), this.login.interval);
    this.timer.unref();
  }
  private async poll(): Promise<void> {
    const login = this.login;
    if (!login) return;
    try {
      if (Date.now() >= login.expires)
        throw new Error("Sign-in expired. Try again.");
      const response = await this.request("/api/auth/device/token", {
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: login.deviceCode,
        client_id: "usageatlas-desktop",
      });
      if (this.login !== login) return;
      if (
        response.error === "authorization_pending" ||
        response.error === "slow_down"
      ) {
        if (response.error === "slow_down") login.interval += 5000;
        this.schedulePoll();
        return;
      }
      if (typeof response.access_token !== "string")
        throw new Error("Sign-in was not approved. Try again.");
      const data = await this.request(
        "/api/auth/get-session",
        undefined,
        response.access_token,
      );
      if (this.login !== login) return;
      const user = data.user as { id?: unknown; email?: unknown } | undefined;
      if (typeof user?.id !== "string" || typeof user.email !== "string")
        throw new Error("Could not verify your account.");
      const session: Session = {
        token: response.access_token,
        user: { id: user.id, email: user.email },
      };
      writeFileSync(
        `${this.filename}.tmp`,
        safeStorage.encryptString(JSON.stringify(session)),
        {
          mode: 0o600,
        },
      );
      renameSync(`${this.filename}.tmp`, this.filename);
      this.session = session;
      await this.configure();
      if (this.login !== login) return;
      this.cancelLogin();
    } catch (error) {
      if (this.login !== login) return;
      this.error = error instanceof Error ? error.message : "Sign-in failed.";
      this.cancelLogin();
    }
    this.changed();
  }
  private cancelLogin(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.login = null;
    this.loginAttempt = null;
  }
  private async request(
    endpoint: string,
    body?: unknown,
    token?: string,
  ): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await fetch(`${BASE_URL}${endpoint}`, {
        method: body ? "POST" : "GET",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(20_000),
        redirect: "error",
      });
    } catch {
      throw new Error(
        "Could not reach UsageAtlas. Check your connection and try again.",
      );
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Empty account response.");
    const decoder = new TextDecoder();
    let text = "";
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 65_536) {
        await reader.cancel();
        throw new Error("Invalid account response.");
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    const value = JSON.parse(text) as Record<string, unknown>;
    if (!value || typeof value !== "object")
      throw new Error("Invalid account response.");
    if (value.error === "expired_token")
      throw new Error("Sign-in expired. Try again.");
    if (value.error === "access_denied")
      throw new Error("Sign-in was cancelled in your browser.");
    if (
      !response.ok &&
      !["authorization_pending", "slow_down"].includes(String(value.error))
    )
      throw new Error(
        response.status === 503
          ? "Cloud accounts are not configured yet."
          : "Account request failed. Try again.",
      );
    return value;
  }
}
