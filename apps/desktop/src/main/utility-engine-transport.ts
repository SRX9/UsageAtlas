import { utilityProcess, type UtilityProcess } from "electron";
import type { EngineRequest } from "../engine/protocol";
import { isEngineReadyMessage, parseEngineResponse } from "../engine/protocol";
import type { EngineTransport, EngineTransportHandlers } from "./engine-transport";

const STARTUP_TIMEOUT_MS = 10_000;

export class UtilityEngineTransport implements EngineTransport {
  private child: UtilityProcess | null = null;

  constructor(
    private readonly entryPath: string,
    private readonly historyDatabasePath?: string
  ) {}

  async start(handlers: EngineTransportHandlers): Promise<void> {
    if (this.child) return;
    const child = utilityProcess.fork(this.entryPath, [], {
      serviceName: "UsageAtlas Engine",
      stdio: "pipe",
      env: {
        ...process.env,
        ...(this.historyDatabasePath
          ? { USAGEATLAS_HISTORY_DB: this.historyDatabasePath }
          : {})
      }
    });
    this.child = child;
    await new Promise<void>((resolve, reject) => {
      let ready = false;
      let settled = false;
      let timeout: NodeJS.Timeout | null = null;
      const clearStartupTimeout = (): void => {
        if (timeout) clearTimeout(timeout);
        timeout = null;
      };
      const completeStartup = (): void => {
        if (settled) return;
        settled = true;
        ready = true;
        clearStartupTimeout();
        resolve();
      };
      const failStartup = (error: Error): void => {
        if (settled) return;
        settled = true;
        clearStartupTimeout();
        reject(error);
      };

      child.on("message", (message) => {
        if (!ready) {
          if (isEngineReadyMessage(message)) {
            completeStartup();
            return;
          }
          const error = new Error("Engine sent an invalid startup message");
          handlers.diagnostic(error.message);
          failStartup(error);
          child.kill();
          return;
        }
        try {
          handlers.message(parseEngineResponse(message));
        } catch (error) {
          handlers.diagnostic(error instanceof Error ? error.message : "Invalid engine response");
          child.kill();
        }
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        for (const line of chunk.toString().split(/\r?\n/u)) if (line) handlers.diagnostic(line);
      });
      child.on("error", (_type, location) => {
        const error = new Error(`Utility process failed at ${location}`);
        handlers.diagnostic(error.message);
        if (!ready) {
          failStartup(error);
          child.kill();
        }
      });
      child.on("exit", (code) => {
        this.child = null;
        if (!ready) failStartup(new Error(`Engine exited during startup (${code})`));
        handlers.exit(code);
      });

      timeout = setTimeout(() => {
        const error = new Error("Engine ready handshake timed out");
        handlers.diagnostic(error.message);
        failStartup(error);
        child.kill();
      }, STARTUP_TIMEOUT_MS);
    });
  }

  send(request: EngineRequest): void {
    if (!this.child) throw new Error("Engine utility process is unavailable");
    this.child.postMessage(request);
  }

  kill(): void {
    this.child?.kill();
    this.child = null;
  }
}
