import { open, readFile, stat } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import type { CandidateKind } from "./patterns";

/**
 * A file name is only a hint. This probe opens the candidate and looks for the
 * shapes usage is actually written in: SQLite columns or JSON blobs holding
 * token counts, OpenAI/Anthropic-style `usage` objects, and event logs where
 * each line carries its own counters. Nothing is reported as usable until a
 * numeric token field has been seen.
 */

export interface UsageShape {
  kind: "sqlite" | "json" | "jsonl";
  /** `table.column` for SQLite, a dotted path or `line:N` for documents. */
  location: string;
  /** The field names that carried the counts. */
  fields: string[];
}

export interface ProbeResult {
  usable: boolean;
  /** 0..1, how sure the probe is that this file holds token usage. */
  confidence: number;
  shape?: UsageShape;
  reason: string;
  /** Rows or records that actually matched. */
  matches: number;
}

const MAX_DOCUMENT_BYTES = 8 * 1024 * 1024;
const MAX_JSON_NODES = 20_000;
const MAX_LINES = 2_000;
const SAMPLE_ROWS = 20;
const STRONG_FIELDS = /(prompt|input|completion|output|total|cached|reasoning).*(tokens?|count)|^(prompt_eval_count|eval_count)$/i;
const TIMESTAMP_FIELD = /^(ts|time|timestamp|created_at|updated_at|date|occurred_at|started_at|at)$/i;
const BLOB_FIELD = /(metrics|usage|meta|payload|data|stats|telemetry|record|event)/i;

export async function probeFile(file: string, kind: CandidateKind): Promise<ProbeResult> {
  if (kind === "database") return probeDatabase(file);
  return probeDocument(file);
}

function probeDatabase(file: string): ProbeResult {
  let database: DatabaseSync;
  try {
    database = new DatabaseSync(file, { readOnly: true, timeout: 500 });
  } catch {
    return { usable: false, confidence: 0, reason: "not a readable SQLite database", matches: 0 };
  }
  try {
    const tables = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name?: unknown }>;
    let best: ProbeResult | null = null;
    for (const table of tables) {
      const name = typeof table.name === "string" ? table.name : "";
      if (!name || name.toLowerCase().startsWith("sqlite_")) continue;
      const result = probeTable(database, name);
      if (result && (!best || result.confidence > best.confidence)) best = result;
    }
    return best ?? { usable: false, confidence: 0, reason: "no table carries token counts", matches: 0 };
  } catch {
    return { usable: false, confidence: 0, reason: "database could not be read", matches: 0 };
  } finally {
    try { database.close(); } catch { /* already closed */ }
  }
}

function probeTable(database: DatabaseSync, table: string): ProbeResult | null {
  const quoted = `"${table.replace(/"/g, '""')}"`;
  const columns = (database.prepare(`PRAGMA table_info(${quoted})`).all() as Array<{ name?: unknown; type?: unknown }>)
    .map(column => ({
      name: typeof column.name === "string" ? column.name : "",
      type: typeof column.type === "string" ? column.type : ""
    }))
    .filter(column => column.name.length > 0);
  if (columns.length === 0) return null;

  const tokenColumns = columns.filter(column => STRONG_FIELDS.test(column.name) && !/json/i.test(column.type));
  const timestamp = columns.find(column => TIMESTAMP_FIELD.test(column.name));
  const blobColumns = columns.filter(column => BLOB_FIELD.test(column.name) && /text|json|blob/i.test(column.type || "text"));

  if (tokenColumns.length > 0) {
    const fields = tokenColumns.map(column => column.name);
    const select = fields.map(field => `"${field.replace(/"/g, '""')}"`).join(", ");
    let rows: Array<Record<string, unknown>>;
    try {
      rows = database.prepare(`SELECT ${select} FROM ${quoted} LIMIT ${SAMPLE_ROWS}`).all() as Array<Record<string, unknown>>;
    } catch {
      return null;
    }
    const matches = rows.filter(row => fields.some(field => isNumber(row[field]))).length;
    if (matches === 0) return null;
    return {
      usable: true,
      confidence: timestamp ? 0.86 : 0.74,
      shape: { kind: "sqlite", location: timestamp ? `${table}.${hitColumn(rows, fields, timestamp.name)}` : `${table}.${fields[0]}`, fields },
      reason: `${table} has token columns${timestamp ? ` and ${timestamp.name}` : " but no timestamp"}`,
      matches
    };
  }

  for (const column of blobColumns) {
    const quotedColumn = `"${column.name.replace(/"/g, '""')}"`;
    let rows: Array<Record<string, unknown>>;
    try {
      rows = database.prepare(`SELECT ${quotedColumn} AS payload FROM ${quoted} WHERE ${quotedColumn} IS NOT NULL LIMIT ${SAMPLE_ROWS}`).all() as Array<Record<string, unknown>>;
    } catch {
      continue;
    }
    let matches = 0;
    const fields = new Set<string>();
    for (const row of rows) {
      const value = row.payload;
      if (typeof value !== "string" || value.length > MAX_DOCUMENT_BYTES) continue;
      const hit = findTokens(parseJson(value));
      if (!hit) continue;
      matches += 1;
      for (const field of hit.fields) fields.add(field);
    }
    if (matches > 0) {
      return {
        usable: true,
        confidence: timestamp ? 0.93 : 0.85,
        shape: { kind: "sqlite", location: `${table}.${column.name}`, fields: [...fields] },
        reason: `${table}.${column.name} carries usage JSON${timestamp ? ` next to ${timestamp.name}` : ""}`,
        matches
      };
    }
  }
  return null;
}

function hitColumn(rows: Array<Record<string, unknown>>, fields: string[], preferred: string): string {
  if (fields.includes(preferred)) return preferred;
  for (const row of rows) {
    const field = fields.find(name => isNumber(row[name]));
    if (field) return field;
  }
  return fields[0];
}

async function probeDocument(file: string): Promise<ProbeResult> {
  let info;
  try {
    info = await stat(file);
  } catch {
    return { usable: false, confidence: 0, reason: "file disappeared", matches: 0 };
  }
  if (!info.isFile() || info.size === 0) return { usable: false, confidence: 0, reason: "empty file", matches: 0 };

  if (/\.(jsonl|ndjson)$/i.test(file)) return probeLines(file, info.size);
  if (info.size > MAX_DOCUMENT_BYTES) {
    return { usable: false, confidence: 0, reason: "too large to inspect safely", matches: 0 };
  }
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return { usable: false, confidence: 0, reason: "file could not be read", matches: 0 };
  }
  const hit = findTokens(parseJson(text));
  if (!hit) return { usable: false, confidence: 0, reason: "no token counters in the document", matches: 0 };
  return {
    usable: true,
    confidence: hit.matches > 1 ? 0.9 : 0.72,
    shape: { kind: "json", location: hit.path, fields: hit.fields },
    reason: `${hit.matches} usage record${hit.matches === 1 ? "" : "s"} at ${hit.path}`,
    matches: hit.matches
  };
}

async function probeLines(file: string, size: number): Promise<ProbeResult> {
  const handler = await open(file, "r").catch(() => null);
  if (!handler) return { usable: false, confidence: 0, reason: "file could not be opened", matches: 0 };
  try {
    const head = Math.min(size, 2 * 1024 * 1024);
    const buffer = Buffer.alloc(head);
    await handler.read(buffer, 0, head, 0);
    const lines = buffer.toString("utf8").split("\n").slice(0, MAX_LINES);
    let matches = 0;
    let fields = new Set<string>();
    let location = "line:1";
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]?.trim();
      if (!line || !line.startsWith("{") && !line.startsWith("[")) continue;
      const hit = findTokens(parseJson(line));
      if (!hit) continue;
      matches += 1;
      if (matches === 1) {
        fields = new Set(hit.fields);
        location = `line:${index + 1}`;
      }
    }
    if (matches === 0) return { usable: false, confidence: 0, reason: "no line carries token counters", matches: 0 };
    return {
      usable: true,
      confidence: matches >= 3 ? 0.9 : 0.76,
      shape: { kind: "jsonl", location, fields: [...fields] },
      reason: `${matches} event${matches === 1 ? "" : "s"} with token counters`,
      matches
    };
  } finally {
    await handler.close().catch(() => undefined);
  }
}

interface TokenHit {
  path: string;
  fields: string[];
  matches: number;
}

/**
 * Walks a parsed document for objects that carry numeric token counters. A pair
 * of bare `input`/`output` numbers counts too, but only when both are present,
 * which keeps configuration files from looking like usage.
 */
function findTokens(root: unknown): TokenHit | null {
  if (root === null || typeof root !== "object") return null;
  const stack: Array<{ value: unknown; path: string; depth: number }> = [{ value: root, path: "$", depth: 0 }];
  let visited = 0;
  let matches = 0;
  let firstPath = "";
  const fields = new Set<string>();
  while (stack.length > 0 && visited < MAX_JSON_NODES) {
    const current = stack.pop()!;
    visited += 1;
    if (current.depth > 6 || current.value === null || typeof current.value !== "object") continue;
    if (Array.isArray(current.value)) {
      for (let index = 0; index < Math.min(current.value.length, 500); index += 1) {
        stack.push({ value: current.value[index], path: `${current.path}[${index}]`, depth: current.depth + 1 });
      }
      continue;
    }
    const record = current.value as Record<string, unknown>;
    const hit = fieldsIn(record);
    if (hit) {
      matches += 1;
      if (!firstPath) firstPath = current.path;
      for (const field of hit) fields.add(field);
    }
    for (const [key, value] of Object.entries(record)) {
      if (value !== null && typeof value === "object") {
        stack.push({ value, path: `${current.path}.${key}`, depth: current.depth + 1 });
      }
    }
  }
  if (matches === 0) return null;
  return { path: firstPath, fields: [...fields], matches };
}

function fieldsIn(record: Record<string, unknown>): string[] | null {
  const strong: string[] = [];
  for (const [key, value] of Object.entries(record)) {
    if (isNumber(value) && STRONG_FIELDS.test(key)) strong.push(key);
  }
  if (strong.length > 0) return strong;
  if (isNumber(record.input) && isNumber(record.output)) return ["input", "output"];
  return null;
}

function isNumber(value: unknown): boolean {
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string" && value.trim().length > 0) return Number.isFinite(Number(value));
  return false;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}
