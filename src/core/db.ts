/**
 * Database access built on Node's built-in SQLite.
 *
 * Deliberately dependency-free: `node:sqlite` ships with Node 22, so there is
 * no native module to rebuild and no ORM to fight. The wrapper adds the three
 * things raw SQLite lacks for application use — statement caching, parameter
 * coercion, and transactions that roll back on throw.
 *
 * SQLite is the right fit here: this control plane serves one operator and a
 * few hundred tenants, the whole dataset fits in memory, and a single file is
 * trivially backed up.
 */

import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { config } from '../config.ts';
import { logger } from './logger.ts';
import { MIGRATIONS } from './migrations.ts';

/** Values accepted as query parameters before coercion. */
export type Param = string | number | bigint | boolean | null | undefined | Date | Uint8Array;

export type Row = Record<string, unknown>;

let database: DatabaseSync | null = null;
const statementCache = new Map<string, StatementSync>();

/**
 * SQLite has no boolean or date type, and rejects `undefined` outright.
 * Coercing here means callers can pass natural JavaScript values everywhere.
 */
function coerce(value: Param): string | number | bigint | null | Uint8Array {
  if (value === undefined || value === null) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value instanceof Date) return value.getTime();
  return value;
}

function coerceAll(params: readonly Param[]): Array<string | number | bigint | null | Uint8Array> {
  return params.map(coerce);
}

/**
 * node:sqlite returns null-prototype objects; normalise to plain objects so
 * spreading, `Object.entries` and structured cloning all behave.
 *
 * The generic is unconstrained rather than `T extends Record<string, unknown>`
 * because callers pass row *interfaces*, which TypeScript does not consider
 * assignable to an index-signature type.
 */
function toPlain<T>(row: unknown): T {
  return Object.assign({}, row) as T;
}

export function getDatabase(): DatabaseSync {
  if (!database) throw new Error('Gagnagrunnur hefur ekki verið opnaður — kallaðu á openDatabase() fyrst.');
  return database;
}

export interface OpenOptions {
  /** Overrides config; ':memory:' is used by the test suite. */
  path?: string;
  /** Skip migrations (used when restoring a backup). */
  migrate?: boolean;
}

export function openDatabase(options: OpenOptions = {}): DatabaseSync {
  if (database) return database;

  const path = options.path ?? config.databasePath;
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true });
  }

  database = new DatabaseSync(path);

  // WAL keeps readers from blocking the writer, which matters once the phone
  // webhook and the admin console are both live.
  if (path !== ':memory:') database.exec('PRAGMA journal_mode = WAL;');
  database.exec('PRAGMA foreign_keys = ON;');
  database.exec('PRAGMA busy_timeout = 5000;');
  database.exec('PRAGMA synchronous = NORMAL;');

  if (options.migrate !== false) migrate();
  return database;
}

export function closeDatabase(): void {
  statementCache.clear();
  database?.close();
  database = null;
}

function prepare(sql: string): StatementSync {
  let statement = statementCache.get(sql);
  if (!statement) {
    statement = getDatabase().prepare(sql);
    statementCache.set(sql, statement);
  }
  return statement;
}

/** Runs a statement, returning affected-row and last-insert information. */
export function run(sql: string, ...params: Param[]): { changes: number; lastInsertRowid: number } {
  const result = prepare(sql).run(...coerceAll(params));
  return { changes: Number(result.changes), lastInsertRowid: Number(result.lastInsertRowid) };
}

export function all<T = Row>(sql: string, ...params: Param[]): T[] {
  return prepare(sql).all(...coerceAll(params)).map((r) => toPlain<T>(r));
}

export function get<T = Row>(sql: string, ...params: Param[]): T | null {
  const row = prepare(sql).get(...coerceAll(params));
  return row === undefined ? null : toPlain<T>(row);
}

/** Single scalar value, or null. */
export function scalar<T = unknown>(sql: string, ...params: Param[]): T | null {
  const row = get(sql, ...params);
  if (!row) return null;
  const values = Object.values(row);
  return (values.length > 0 ? (values[0] as T) : null);
}

export function exec(sql: string): void {
  getDatabase().exec(sql);
}

/**
 * Runs `fn` inside a transaction, rolling back if it throws.
 *
 * Nested calls join the outer transaction via SAVEPOINT so that domain
 * services can be composed without either one having to know whether it is
 * the outermost caller.
 */
let transactionDepth = 0;
export function transaction<T>(fn: () => T): T {
  const db = getDatabase();
  const isOutermost = transactionDepth === 0;
  const savepoint = `sp_${transactionDepth}`;

  db.exec(isOutermost ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${savepoint}`);
  transactionDepth++;

  try {
    const result = fn();
    transactionDepth--;
    db.exec(isOutermost ? 'COMMIT' : `RELEASE ${savepoint}`);
    return result;
  } catch (error) {
    transactionDepth--;
    try {
      db.exec(isOutermost ? 'ROLLBACK' : `ROLLBACK TO ${savepoint}`);
      if (!isOutermost) db.exec(`RELEASE ${savepoint}`);
    } catch (rollbackError) {
      logger.error('Rollback mistókst', { error: rollbackError });
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// JSON column helpers
// ---------------------------------------------------------------------------

export function toJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}

export function fromJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || value === '') return fallback;
  try {
    const parsed = JSON.parse(value);
    return (parsed ?? fallback) as T;
  } catch {
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// Migrations
// ---------------------------------------------------------------------------

export function migrate(): number {
  const db = getDatabase();
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    );
  `);

  const applied = new Set(
    all<{ version: number }>('SELECT version FROM schema_migrations').map((r) => r.version),
  );

  let count = 0;
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue;
    logger.info('Keyri færslu á gagnagrunni', { version: migration.version, name: migration.name });

    // DDL in SQLite is transactional, so a failed migration leaves no debris.
    db.exec('BEGIN');
    try {
      db.exec(migration.sql);
      db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
        migration.version,
        migration.name,
        Date.now(),
      );
      db.exec('COMMIT');
      count++;
    } catch (error) {
      db.exec('ROLLBACK');
      logger.error('Færsla mistókst', { version: migration.version, error });
      throw error;
    }
  }

  if (count > 0) logger.info('Gagnagrunnur uppfærður', { migrations: count });
  return count;
}

/** Current schema version — surfaced on the admin dashboard. */
export function schemaVersion(): number {
  return scalar<number>('SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations') ?? 0;
}
