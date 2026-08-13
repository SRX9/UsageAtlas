import { DatabaseSync, type SQLInputValue } from "node:sqlite";

export type SqliteRow = Record<string, unknown>;

export interface ReadonlySqliteDatabase {
  all(sql: string, parameters?: SQLInputValue[]): SqliteRow[];
  get(sql: string, parameters?: SQLInputValue[]): SqliteRow | null;
  close(): void;
}

export interface ReadonlySqliteFactory {
  open(databasePath: string): ReadonlySqliteDatabase;
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
