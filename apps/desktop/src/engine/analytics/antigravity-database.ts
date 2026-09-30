import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { UsageRecord } from "./local-usage";
import type { ParsedSession } from "./session-source";
import { counter, localRecord, sum } from "./session-values";
import { decodeAntigravityStep, decodeAntigravityTurn, type AntigravityStep, type AntigravityTurn } from "./antigravity-protobuf";

export interface AntigravityDatabaseInput { files: string[]; maxBytes: number; }
export interface AntigravityDatabaseResult extends ParsedSession { files: number; visited: number; }
interface SourceRow { record: UsageRecord; index: number; responseID: string | null; }

/** Executed in the worker. Only numeric records leave this thread. */
export function readAntigravityDatabases(input: AntigravityDatabaseInput): AntigravityDatabaseResult {
  const result: AntigravityDatabaseResult = { records: [], files: 0, visited: 0, partial: false };
  const budget = { bytes: input.maxBytes, rows: 50_000, deadline: Date.now() + 10_000 };
  const rows = new Map<string, SourceRow>(), conflicts = new Set<string>(), responseConflicts = new Set<string>();
  const responseKey = (row: SourceRow) => row.responseID ? JSON.stringify([row.record.sessionID, row.responseID]) : null;
  for (const file of input.files) {
    try {
      const session = readDatabase(file, budget);
      if (session) {
        result.files++; result.partial ||= session.partial;
        for (const row of session.rows) {
          const key = row.record.eventKey, prior = rows.get(key);
          if (prior && (JSON.stringify(prior.record) !== JSON.stringify(row.record)
            || (prior.responseID && row.responseID && prior.responseID !== row.responseID))) {
            conflicts.add(key); result.partial = true;
            for (const candidate of [prior, row]) { const response = responseKey(candidate); if (response) responseConflicts.add(response); }
          } else if (!prior || row.responseID) rows.set(key, row);
        }
      }
    } catch { result.partial = true; }
    result.visited++;
    if (budget.rows <= 0 || budget.bytes <= 0 || Date.now() > budget.deadline) { result.partial = true; break; }
  }
  const responses = new Map<string, SourceRow>();
  for (const row of rows.values()) {
    if (conflicts.has(row.record.eventKey)) continue;
    const key = responseKey(row);
    if (!key) { result.records.push(row.record); continue; }
    const prior = responses.get(key);
    const comparable = (value: SourceRow) => JSON.stringify({ ...value.record, eventKey: "" });
    if (prior && comparable(prior) !== comparable(row)) { responseConflicts.add(key); result.partial = true; }
    else if (!prior || row.index < prior.index) responses.set(key, row);
  }
  for (const [key, row] of responses) if (!responseConflicts.has(key)) result.records.push(row.record);
  return result;
}

interface Budget { bytes: number; rows: number; deadline: number; }
interface DatabaseSession { rows: SourceRow[]; partial: boolean; }
function readDatabase(filename: string, budget: Budget): DatabaseSession | null {
  const db = new DatabaseSync(filename, { readOnly: true, allowExtension: false });
  const result: DatabaseSession = { rows: [], partial: false };
  try {
    db.exec("PRAGMA query_only = ON; PRAGMA trusted_schema = OFF; PRAGMA busy_timeout = 250; BEGIN DEFERRED;");
    const schema = db.prepare("SELECT name, type, rootpage FROM main.sqlite_master LIMIT 129").all();
    if (!schema.length || schema.length > 128) throw new Error("Unsupported database schema.");
    const hasTable = (table: string, payload: string): boolean => {
      const item = schema.find(row => row.name === table);
      if (!item) return false;
      if (item.type !== "table" || typeof item.rootpage !== "number" || item.rootpage <= 0) throw new Error("Expected ordinary history table.");
      const columns = db.prepare(`PRAGMA main.table_xinfo(${table})`).all();
      if (columns.length > 64 || !["idx", payload].every(name => columns.some(column => column.name === name && column.hidden === 0))) throw new Error("Unsupported history columns.");
      return true;
    };
    // conversation_summaries.db shares a root but carries no generation history.
    if (!hasTable("gen_metadata", "data")) return null;
    const session = path.basename(filename, ".db");
    const turns: { index: number; turn: AntigravityTurn }[] = [], steps: { index: number; step: AntigravityStep }[] = [];
    const scan = (table: "gen_metadata" | "steps", column: "data" | "metadata", visit: (index: number, data: Uint8Array) => void): void => {
      // Bound each materialized BLOB before SQLite returns it. Iteration holds one row at a time.
      const query = db.prepare(`SELECT idx, length(${column}) AS bytes,
        CASE WHEN typeof(${column}) = 'blob' AND length(${column}) <= ? THEN ${column} ELSE NULL END AS payload
        FROM ${table} LIMIT 10001`);
      let count = 0;
      for (const row of query.iterate(Math.min(16 * 1024 * 1024, Math.max(0, budget.bytes)))) {
        if (++count > 10000 || --budget.rows < 0 || Date.now() > budget.deadline) throw new Error("History scan budget exhausted.");
        const size = typeof row.bytes === "number" ? counter(row.bytes) : 0;
        budget.bytes -= size;
        if (budget.bytes < 0) throw new Error("History byte budget exhausted.");
        try {
          const index = counter(row.idx);
          if (!size || !(row.payload instanceof Uint8Array) || row.payload.byteLength !== size) throw new Error("Unsupported payload.");
          visit(index, row.payload);
        } catch { result.partial = true; }
      }
    };
    scan("gen_metadata", "data", (index, data) => turns.push({ index, turn: decodeAntigravityTurn(data) }));
    if (turns.some(row => !row.turn.timestamp) && hasTable("steps", "metadata")) {
      scan("steps", "metadata", (index, data) => steps.push({ index, step: decodeAntigravityStep(data) }));
    }
    // Missing rows prevent a complete UUID/bot census, so do not infer uniqueness in that case.
    if (!result.partial) recoverTimes(turns, steps);
    const models = new Map<string, Set<string>>();
    for (const { turn } of turns) if (turn.label && turn.model) {
      const labels = models.get(turn.label) ?? new Set<string>(); labels.add(turn.model); models.set(turn.label, labels);
    }
    const indices = new Set<number>();
    for (const { index, turn } of turns) {
      if (indices.has(index)) throw new Error("Duplicate generation index.");
      indices.add(index);
      if (!turn.timestamp) { result.partial = true; continue; }
      const candidates = turn.label ? models.get(turn.label) : null;
      const model = turn.model ?? (candidates?.size === 1 ? [...candidates][0] : "unknown");
      try {
        const record = localRecord({ timestamp: turn.timestamp, sessionID: session, model,
          modelProvider: /^claude/i.test(model) ? "anthropic" : /^(?:gpt|o\d)/i.test(model) ? "openai" : /^gemini/i.test(model) ? "google" : undefined,
          eventKey: `antigravity|${session}|row:${index}`,
          inputTokens: turn.input, cachedInputTokens: turn.cacheRead, cacheCreationInputTokens: 0, outputTokens: sum(turn.output, turn.reasoning),
          rawTokens: { systemPrompt: turn.systemPrompt, newInput: turn.newInput, cacheRead: turn.cacheRead, output: turn.output, reasoning: turn.reasoning } });
        result.rows.push({ record, index, responseID: turn.responseID });
      } catch { result.partial = true; }
    }
    return result;
  } finally { db.close(); }
}

/** Recover only timestamps linked to the generation, never file mtime or session start. */
function recoverTimes(turns: { index: number; turn: AntigravityTurn }[], steps: { index: number; step: AntigravityStep }[]): void {
  const bots = new Map<string, AntigravityStep>(), ambiguous = new Set<string>();
  const botUses = new Map<string, number>();
  const generationCounts = new Map<string, number>(), stepsByID = new Map<string, AntigravityStep[]>();
  for (const { turn } of turns) {
    if (turn.botID) botUses.set(turn.botID, (botUses.get(turn.botID) ?? 0) + 1);
    if (turn.stepID) generationCounts.set(turn.stepID, (generationCounts.get(turn.stepID) ?? 0) + 1);
  }
  for (const { step } of steps) if (step.stepID) {
    const group = stepsByID.get(step.stepID) ?? []; group.push(step); stepsByID.set(step.stepID, group);
  }
  for (const { step } of steps) if (step.botID) {
    const prior = bots.get(step.botID);
    if (!step.stepID || !step.timestamp || (prior && (prior.stepID !== step.stepID || prior.timestamp !== step.timestamp))) ambiguous.add(step.botID);
    bots.set(step.botID, step);
  }
  for (const { turn } of turns) {
    if (turn.timestamp || !turn.stepID) continue;
    if (turn.botID && ambiguous.has(turn.botID)) continue;
    const exact = turn.botID && botUses.get(turn.botID) === 1 ? bots.get(turn.botID) : null;
    if (exact) { if (exact.stepID === turn.stepID) turn.timestamp = exact.timestamp; continue; }
    const matching = stepsByID.get(turn.stepID) ?? [];
    if (generationCounts.get(turn.stepID) === 1 && matching.length === 1 && matching[0].timestamp
      && (!matching[0].botID || !ambiguous.has(matching[0].botID))) turn.timestamp = matching[0].timestamp;
    // Reused UUIDs without a unique bot match are deliberately left incomplete.
  }
}
