import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync, type SQLInputValue, type SQLOutputValue } from 'node:sqlite';

// Just enough of D1 for the Worker's queries, on top of Node's built-in SQLite, so the real
// request handler runs against the real migrations in tests. It is not D1: limits, timing
// and concurrency differ.

type BoundValue = string | number | null | ArrayBuffer;
type Row = Record<string, SQLOutputValue>;

const MIGRATIONS_DIRECTORY = join(import.meta.dirname, '..', '..', 'migrations');

function toSqlite(value: BoundValue): SQLInputValue {
  return value instanceof ArrayBuffer ? new Uint8Array(value) : value;
}

/** D1 hands a BLOB back as an array of byte values. */
function fromSqlite(row: Row): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [column, value] of Object.entries(row)) {
    result[column] = value instanceof Uint8Array ? Array.from(value) : value;
  }
  return result;
}

class FakeStatement {
  sqlite: DatabaseSync;
  sql: string;
  values: SQLInputValue[];

  constructor(sqlite: DatabaseSync, sql: string, values: SQLInputValue[]) {
    this.sqlite = sqlite;
    this.sql = sql;
    this.values = values;
  }

  bind(...values: BoundValue[]): FakeStatement {
    return new FakeStatement(this.sqlite, this.sql, values.map(toSqlite));
  }

  first(): Promise<Record<string, unknown> | null> {
    const row = this.sqlite.prepare(this.sql).get(...this.values);
    return Promise.resolve(row ? fromSqlite(row) : null);
  }

  all(): Promise<{ results: Record<string, unknown>[] }> {
    const rows = this.sqlite.prepare(this.sql).all(...this.values);
    return Promise.resolve({ results: rows.map(fromSqlite) });
  }

  run(): Promise<{ meta: { changes: number } }> {
    return Promise.resolve(this.runNow());
  }

  runNow(): { meta: { changes: number } } {
    const result = this.sqlite.prepare(this.sql).run(...this.values);
    return { meta: { changes: Number(result.changes) } };
  }
}

class FakeDatabase {
  sqlite: DatabaseSync;

  constructor(sqlite: DatabaseSync) {
    this.sqlite = sqlite;
  }

  prepare(sql: string): FakeStatement {
    return new FakeStatement(this.sqlite, sql, []);
  }

  /** Like D1, a batch is one transaction: all statements apply or none do. */
  batch(statements: FakeStatement[]): Promise<{ meta: { changes: number } }[]> {
    this.sqlite.exec('BEGIN');
    try {
      const results = statements.map((statement) => statement.runNow());
      this.sqlite.exec('COMMIT');
      return Promise.resolve(results);
    } catch (error) {
      this.sqlite.exec('ROLLBACK');
      throw error;
    }
  }
}

export interface TestDatabase {
  /** Pass this to the Worker as its DB binding. */
  db: D1Database;
  /** Direct access, for seeding and for looking at rows in assertions. */
  sqlite: DatabaseSync;
}

export function createTestDatabase(): TestDatabase {
  const sqlite = new DatabaseSync(':memory:');
  // D1 enforces foreign keys; plain SQLite only does when asked.
  sqlite.exec('PRAGMA foreign_keys = ON');
  for (const file of readdirSync(MIGRATIONS_DIRECTORY).sort()) {
    sqlite.exec(readFileSync(join(MIGRATIONS_DIRECTORY, file), 'utf8'));
  }
  // The fake implements only the part of D1Database that the Worker calls.
  return { db: new FakeDatabase(sqlite) as unknown as D1Database, sqlite };
}
