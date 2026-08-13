import type { JsonValue } from "@usageatlas/contracts";

export const ENGINE_MESSAGE_LIMIT = 1_048_576;
export const ENGINE_PROTOCOL_VERSION = 1 as const;

export type EngineMethod = "snapshot.get" | "provider.refresh" | "config.update" | "shutdown";

export interface EngineRequest {
  id: string;
  method: EngineMethod;
  params: Record<string, JsonValue>;
}

export interface EngineReadyMessage {
  type: "engine.ready";
  protocolVersion: typeof ENGINE_PROTOCOL_VERSION;
}

export type EngineResponse =
  | { id: string; ok: true; result: JsonValue; error: null }
  | {
      id: string;
      ok: false;
      result: null;
      error: { code: string; message: string; retryable: boolean };
    };

export function parseEngineRequest(value: unknown): EngineRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidRequest();
  const request = value as Record<string, unknown>;
  if (typeof request.id !== "string" || request.id.length === 0 || request.id.length > 128) {
    throw invalidRequest();
  }
  if (!isMethod(request.method)) throw invalidRequest();
  if (!request.params || typeof request.params !== "object" || Array.isArray(request.params)) {
    throw invalidRequest();
  }
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > ENGINE_MESSAGE_LIMIT) {
    throw new EngineRequestError("message_too_large", "Engine request exceeded the byte limit.");
  }
  return request as unknown as EngineRequest;
}

export class EngineRequestError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "EngineRequestError";
  }
}

export function createEngineReadyMessage(): EngineReadyMessage {
  return { type: "engine.ready", protocolVersion: ENGINE_PROTOCOL_VERSION };
}

export function isEngineReadyMessage(value: unknown): value is EngineReadyMessage {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const message = value as Record<string, unknown>;
  return Object.keys(message).length === 2
    && message.type === "engine.ready"
    && message.protocolVersion === ENGINE_PROTOCOL_VERSION;
}

export function parseEngineResponse(value: unknown): EngineResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidResponse();
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > ENGINE_MESSAGE_LIMIT) {
    throw new EngineRequestError("message_too_large", "Engine response exceeded the byte limit.");
  }
  const response = value as Record<string, unknown>;
  if (typeof response.id !== "string" || response.id.length === 0 || response.id.length > 128) {
    throw invalidResponse();
  }
  if (response.ok === true && response.error === null && "result" in response) {
    return response as unknown as EngineResponse;
  }
  if (response.ok === false && response.result === null && isError(response.error)) {
    return response as unknown as EngineResponse;
  }
  throw invalidResponse();
}

function isMethod(value: unknown): value is EngineMethod {
  return value === "snapshot.get"
    || value === "provider.refresh"
    || value === "config.update"
    || value === "shutdown";
}

function invalidRequest(): EngineRequestError {
  return new EngineRequestError("invalid_request", "Engine request is malformed.");
}

function invalidResponse(): EngineRequestError {
  return new EngineRequestError("invalid_response", "Engine response is malformed.");
}

function isError(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const error = value as Record<string, unknown>;
  return typeof error.code === "string"
    && typeof error.message === "string"
    && typeof error.retryable === "boolean";
}
