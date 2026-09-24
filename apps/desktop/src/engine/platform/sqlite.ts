import { Worker } from "node:worker_threads";
import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";

export type SqliteRow = Record<string, unknown>;

export interface ReadonlySqliteDatabase {
  all(sql: string, parameters?: SQLInputValue[]): SqliteRow[];
  get(sql: string, parameters?: SQLInputValue[]): SqliteRow | null;
  close(): void;
}

export interface ReadonlySqliteFactory {
  open(databasePath: string): ReadonlySqliteDatabase;
}

export interface SqliteOperation { sql: string; parameters: SQLInputValue[]; }

export interface WritableSqliteDatabase extends ReadonlySqliteDatabase {
  commit(operations: SqliteOperation[]): Promise<void>;
  close(): Promise<void>;
  run(sql: string, parameters?: SQLInputValue[]): void;
  exec(sql: string): void;
}

export class NodeReadonlySqliteFactory implements ReadonlySqliteFactory {
  open(databasePath: string): ReadonlySqliteDatabase {
    const database = new DatabaseSync(databasePath, {
      allowExtension: false,
      readOnly: true
    });
    database.exec("PRAGMA query_only = ON; PRAGMA busy_timeout = 250;");
    return {
      all: (sql, parameters = []) => database.prepare(sql).all(...parameters) as SqliteRow[],
      get: (sql, parameters = []) => (
        database.prepare(sql).get(...parameters) as SqliteRow | undefined
      ) ?? null,
      close: () => database.close()
    };
  }
}

export function openWritableSqlite(databasePath: string): WritableSqliteDatabase {
  const database = new DatabaseSync(databasePath, { allowExtension: false });
  database.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 2000; PRAGMA foreign_keys = ON; PRAGMA synchronous = FULL; PRAGMA cache_size = -65536; PRAGMA journal_size_limit = 67108864;");
  let closed = false;
  // Durable batch commits and checkpoints run on a separate connection so a
  // slow disk flush cannot block the engine. Small summary writes stay synchronous.
  const writer = databasePath === ":memory:" ? null : createSqliteWriter(databasePath, () => {
    if (!closed) database.exec("PRAGMA wal_autocheckpoint = 0");
  }, () => {
    if (!closed) database.exec("PRAGMA wal_autocheckpoint = 1000");
  });
  // Keep up to 64 MiB of pages while filling the indexed observation ledger.
  // Collection inserts tens of thousands of rows with the same statements.
  // Recompiling each query also repeatedly reparses the schema and its indexes.
  const statements = new Map<string, StatementSync>();
  const prepare = (sql: string): StatementSync => {
    let statement = statements.get(sql);
    if (!statement) {
      if (statements.size >= 128) statements.clear();
      statement = database.prepare(sql);
      statements.set(sql, statement);
    }
    return statement;
  };
  return {
    all: (sql, parameters = []) => prepare(sql).all(...parameters) as SqliteRow[],
    get: (sql, parameters = []) => (
      prepare(sql).get(...parameters) as SqliteRow | undefined
    ) ?? null,
    run: (sql, parameters = []) => {
      prepare(sql).run(...parameters);
    },
    exec: (sql) => database.exec(sql),
    commit: async operations => {
      if (closed) throw new Error("History database is closed.");
      if (writer) return writer.commit(operations);
      database.exec("BEGIN IMMEDIATE");
      try {
        for (const operation of operations) prepare(operation.sql).run(...operation.parameters);
        database.exec("COMMIT");
      } catch (error) { database.exec("ROLLBACK"); throw error; }
    },
    close: async () => {
      if (closed) return;
      closed = true;
      // Keep the checkpoint connection open until the writer has closed. The
      // last connection's final checkpoint must also stay off the engine thread.
      database.close();
      await writer?.close();
    }
  };
}

function createSqliteWriter(filename: string, ready: () => void, failed: () => void): {
  commit(operations: SqliteOperation[]): Promise<void>;
  close(): Promise<void>;
} | null {
  try {
    const worker = new Worker(`
      const { parentPort, workerData } = require("node:worker_threads");
      const { DatabaseSync } = require("node:sqlite");
      const db = new DatabaseSync(workerData, { allowExtension: false });
      db.exec("PRAGMA busy_timeout = 2000; PRAGMA wal_autocheckpoint = 0; PRAGMA foreign_keys = ON; PRAGMA synchronous = FULL; PRAGMA cache_size = -65536; PRAGMA journal_size_limit = 67108864;");
      const statements = new Map();
      const prepare = sql => {
        let statement = statements.get(sql);
        if (!statement) {
          if (statements.size >= 128) statements.clear();
          statement = db.prepare(sql); statements.set(sql, statement);
        }
        return statement;
      };
      const checkpoint = db.prepare("PRAGMA wal_checkpoint(PASSIVE)");
      let timer;
      const schedule = () => {
        clearTimeout(timer);
        timer = setTimeout(() => { checkpoint.get(); schedule(); }, 5000);
      };
      parentPort.on("message", message => {
        clearTimeout(timer);
        if (message === "close") { db.close(); parentPort.close(); return; }
        try {
          db.exec("BEGIN IMMEDIATE");
          try {
            for (const operation of message.operations) prepare(operation.sql).run(...operation.parameters);
            db.exec("COMMIT");
          } catch (error) { db.exec("ROLLBACK"); throw error; }
          parentPort.postMessage({ id: message.id, error: null });
        } catch (error) { parentPort.postMessage({ id: message.id, error: error.message }); }
        schedule();
      });
      schedule();
      parentPort.postMessage("ready");
    `, { eval: true, workerData: filename });
    let sequence = 0, stopped = false;
    const pending = new Map<number, { resolve(): void; reject(error: Error): void }>();
    const stop = () => {
      stopped = true; failed();
      for (const request of pending.values()) request.reject(new Error("History writer stopped. Refresh usage to retry."));
      pending.clear();
    };
    worker.on("message", message => {
      if (message === "ready") { ready(); return; }
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      if (message.error) request.reject(new Error(message.error)); else request.resolve();
    });
    worker.once("error", stop);
    const exited = new Promise<void>(resolve => worker.once("exit", () => { stop(); resolve(); }));
    worker.unref();
    return {
      commit: operations => new Promise<void>((resolve, reject) => {
        if (stopped) { reject(new Error("History writer stopped. Refresh usage to retry.")); return; }
        const id = ++sequence;
        pending.set(id, { resolve, reject });
        worker.postMessage({ id, operations });
      }),
      close: async () => { worker.postMessage("close"); await exited; }
    };
  } catch {
    return null;
  }
}
