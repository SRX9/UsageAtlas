import { counter, sum } from "./session-values";

// Field layout verified against CodexBar f795611 and its pinned Tokscale reader.
// Decode only known usage/timestamp envelopes; opaque timestamp layouts stay unsupported.
interface Field { number: number; wire: number; value?: bigint; bytes?: Uint8Array; }
const utf8 = new TextDecoder("utf-8", { fatal: true });

function* fields(bytes: Uint8Array): Generator<Field> {
  let offset = 0;
  const varint = (): bigint => {
    let result = 0n;
    for (let i = 0; i < 10; i++) {
      if (offset >= bytes.length) throw new Error("Truncated protobuf.");
      const byte = bytes[offset++];
      if (i === 9 && byte > 1) throw new Error("Overflowed protobuf varint.");
      result |= BigInt(byte & 127) << BigInt(i * 7);
      if (byte < 128) return result;
    }
    throw new Error("Invalid protobuf varint.");
  };
  while (offset < bytes.length) {
    const tag = varint(), number = Number(tag >> 3n), wire = Number(tag & 7n);
    if (number < 1 || number > 536870911) throw new Error("Invalid protobuf field.");
    if (wire === 0) { yield { number, wire, value: varint() }; continue; }
    const length = wire === 2 ? Number(varint()) : wire === 1 ? 8 : wire === 5 ? 4 : NaN;
    if (!Number.isSafeInteger(length) || length < 0 || length > bytes.length - offset) throw new Error("Invalid protobuf framing.");
    yield { number, wire, bytes: bytes.subarray(offset, offset + length) };
    offset += length;
  }
}
function message(field: Field): Uint8Array {
  if (field.wire !== 2 || !field.bytes) throw new Error("Expected protobuf message.");
  return field.bytes;
}
function integer(field: Field): number {
  if (field.wire !== 0 || field.value === undefined) throw new Error("Expected protobuf integer.");
  return counter(Number(field.value));
}
function string(field: Field): string | null {
  const value = utf8.decode(message(field));
  return value.trim() ? value : null;
}
interface ProtoTime { seconds?: number; nanos?: number; }
function readTime(bytes: Uint8Array, time: ProtoTime): void {
  for (const field of fields(bytes)) {
    if (field.number === 1) {
      const seconds = integer(field);
      if (!seconds || seconds > 253402300799) throw new Error("Invalid timestamp seconds.");
      time.seconds = seconds;
    } else if (field.number === 2) {
      const nanos = integer(field);
      if (nanos > 999999999) throw new Error("Invalid timestamp nanos.");
      time.nanos = nanos;
    }
  }
}
function isoTime(time: ProtoTime): string | null {
  return time.seconds ? new Date(time.seconds * 1000 + Math.floor((time.nanos ?? 0) / 1_000_000)).toISOString() : null;
}

export interface AntigravityTurn {
  input: number; cacheRead: number; output: number; reasoning: number;
  systemPrompt: number; newInput: number;
  model: string | null; label: string | null; responseID: string | null;
  stepID: string | null; botID: string | null; timestamp: string | null;
}
export function decodeAntigravityTurn(bytes: Uint8Array): AntigravityTurn {
  const turn: AntigravityTurn = { input: 0, cacheRead: 0, output: 0, reasoning: 0, systemPrompt: 0, newInput: 0,
    model: null, label: null, responseID: null, stepID: null, botID: null, timestamp: null };
  const time: ProtoTime = {};
  let foundUsage = false, invalidBot = false;
  for (const root of fields(bytes)) {
    if (root.number === 4) turn.stepID = string(root);
    if (root.number !== 1) continue;
    for (const chat of fields(message(root))) {
      if (chat.number === 19) turn.model = string(chat);
      if (chat.number === 21) turn.label = string(chat);
      if (chat.number === 9) for (const generation of fields(message(chat))) {
        if (generation.number === 4) readTime(message(generation), time);
      }
      if (chat.number !== 4) continue;
      foundUsage = true;
      for (const usage of fields(message(chat))) {
        switch (usage.number) {
          case 1: turn.systemPrompt = integer(usage); break;
          case 2: turn.newInput = integer(usage); break;
          case 5: turn.cacheRead = integer(usage); break;
          case 9: turn.output = integer(usage); break;
          case 10: turn.reasoning = integer(usage); break;
          case 11: turn.responseID = string(usage); break;
          case 7:
            try { turn.botID = string(usage); } catch { invalidBot = true; }
            break;
        }
      }
    }
  }
  if (!foundUsage) throw new Error("No generation usage envelope.");
  if (invalidBot) turn.botID = null;
  turn.input = sum(turn.systemPrompt, turn.newInput);
  turn.timestamp = isoTime(time);
  return turn;
}

export interface AntigravityStep { stepID: string | null; botID: string | null; timestamp: string | null; }
export function decodeAntigravityStep(bytes: Uint8Array): AntigravityStep {
  const step: AntigravityStep = { stepID: null, botID: null, timestamp: null };
  const time: ProtoTime = {};
  let invalidTime = false, invalidBot = false;
  for (const field of fields(bytes)) {
    if (field.number === 12) step.stepID = string(field);
    if (field.number === 1) try { readTime(message(field), time); } catch { invalidTime = true; }
    if (field.number === 9) try {
      for (const bot of fields(message(field))) if (bot.number === 7) step.botID = string(bot);
    } catch { invalidBot = true; }
  }
  step.timestamp = invalidTime ? null : isoTime(time);
  if (invalidBot) step.botID = null;
  return step;
}
