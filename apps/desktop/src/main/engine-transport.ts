import type { EngineRequest, EngineResponse } from "../engine/protocol";

export interface EngineTransportHandlers {
  message(response: EngineResponse): void;
  diagnostic(message: string): void;
  exit(code: number): void;
}

export interface EngineTransport {
  start(handlers: EngineTransportHandlers): Promise<void>;
  send(request: EngineRequest): void;
  kill(): void;
}

export type EngineTransportFactory = () => EngineTransport;
