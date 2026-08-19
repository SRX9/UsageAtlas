import { EngineService } from "./engine-service";
import { MemoryHistoryStore, SqliteHistoryStore, type HistoryStore } from "./history";
import {
  createEngineReadyMessage,
  EngineRequestError,
  parseEngineRequest,
  type EngineResponse
} from "./protocol";
import { createProviderAdapters } from "./providers/registry";

const port = process.parentPort;
if (!port) throw new Error("Engine utility process parent port is unavailable");

const history = openHistoryStore(process.env.USAGEATLAS_HISTORY_DB);
const engine = new EngineService(createProviderAdapters(), () => new Date(), history);
let queue = Promise.resolve();

port.on("message", (event) => {
  queue = queue.then(async () => {
    let response: EngineResponse;
    try {
      const request = parseEngineRequest(event.data);
      response = await engine.handle(request);
    } catch (error) {
      const known = error instanceof EngineRequestError
        ? error
        : new EngineRequestError("invalid_request", "Engine request is malformed.");
      response = {
        id: requestID(event.data),
        ok: false,
        result: null,
        error: { code: known.code, message: known.message, retryable: false }
      };
    }
    port.postMessage(response);
    if (response.ok && isShutdown(event.data)) setImmediate(() => process.exit(0));
  }).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : "Engine failure"}\n`);
  });
});

port.postMessage(createEngineReadyMessage());

function openHistoryStore(databasePath: string | undefined): HistoryStore {
  if (!databasePath?.trim()) return new MemoryHistoryStore();
  try {
    return SqliteHistoryStore.open(databasePath.trim());
  } catch (error) {
    process.stderr.write(
      `History store unavailable; continuing without persistence (${
        error instanceof Error ? error.message : "open failed"
      })\n`
    );
    return new MemoryHistoryStore();
  }
}

function requestID(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "invalid";
  const id = (value as Record<string, unknown>).id;
  return typeof id === "string" && id.length <= 128 ? id : "invalid";
}

function isShutdown(value: unknown): boolean {
  return Boolean(value && typeof value === "object" && (value as Record<string, unknown>).method === "shutdown");
}
