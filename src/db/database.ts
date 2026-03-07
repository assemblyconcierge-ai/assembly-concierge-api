// ============================================================
// Assembly Concierge v6 — Database Layer
//
// Dual-mode: Postgres (production) or in-memory SQLite (dev/test).
// Set DATABASE_URL env var to use Postgres.
// When DATABASE_URL is absent, falls back to sql.js (in-memory).
//
// All existing sql.js helpers (dbRun, dbGet, dbAll, dbChanges, now)
// are preserved for backward compatibility with repositories.
// ============================================================

// ── Postgres adapter ─────────────────────────────────────────

export interface PgAdapter {
  mode: 'postgres';
  query(sql: string, params?: unknown[]): Promise<Record<string, unknown>[]>;
  queryOne(sql: string, params?: unknown[]): Promise<Record<string, unknown> | null>;
  run(sql: string, params?: unknown[]): Promise<void>;
  close(): Promise<void>;
}

async function createPostgresAdapter(databaseUrl: string): Promise<PgAdapter> {
  const { Pool } = await import('pg');
  const pool = new Pool({
    connectionString: databaseUrl,
    ssl: databaseUrl.includes('localhost') || databaseUrl.includes('127.0.0.1')
      ? false
      : { rejectUnauthorized: false },
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  });

  function toPostgres(sql: string): string {
    let i = 0;
    return sql.replace(/\?/g, () => `$${++i}`);
  }

  return {
    mode: 'postgres',
    async query(sql, params = []) {
      const result = await pool.query(toPostgres(sql), params as unknown[]);
      return result.rows;
    },
    async queryOne(sql, params = []) {
      const result = await pool.query(toPostgres(sql), params as unknown[]);
      return result.rows[0] ?? null;
    },
    async run(sql, params = []) {
      await pool.query(toPostgres(sql), params as unknown[]);
    },
    async close() {
      await pool.end();
    },
  };
}

// ── SQLite (sql.js) — unchanged from v5 ─────────────────────

import initSqlJs from 'sql.js';
import type { Database } from 'sql.js';

export type { Database };

export function dbRun(db: Database, sql: string, params: any[] = []): void {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  stmt.step();
  stmt.free();
}

export function dbGet<T>(db: Database, sql: string, params: any[] = []): T | undefined {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  if (stmt.step()) {
    const row = stmt.getAsObject() as T;
    stmt.free();
    return row;
  }
  stmt.free();
  return undefined;
}

export function dbAll<T>(db: Database, sql: string, params: any[] = []): T[] {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows: T[] = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject() as T);
  }
  stmt.free();
  return rows;
}

export function dbChanges(db: Database): number {
  const result = db.exec('SELECT changes()');
  if (result.length === 0) return 0;
  return result[0].values[0][0] as number;
}

export function now(): string {
  return new Date().toISOString();
}

function applySchema(db: Database): void {
  db.run('PRAGMA foreign_keys = ON;');

  db.run(`
    CREATE TABLE IF NOT EXISTS customers (
      customer_id   TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      email         TEXT NOT NULL,
      phone         TEXT,
      email_lower   TEXT NOT NULL,
      created_at    TEXT NOT NULL,
      updated_at    TEXT NOT NULL,
      UNIQUE (email_lower)
    );
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS booking_requests (
      booking_id        TEXT PRIMARY KEY,
      customer_id       TEXT NOT NULL REFERENCES customers(customer_id),
      idempotency_key   TEXT NOT NULL UNIQUE,
      service_type      TEXT NOT NULL,
      rush              INTEGER NOT NULL DEFAULT 0,
      rush_type         TEXT NOT NULL DEFAULT 'NO_RUSH',
      raw_address       TEXT NOT NULL,
      resolved_city     TEXT,
      resolved_zip      TEXT,
      area_status       TEXT NOT NULL DEFAULT 'IN_AREA',
      price_version     INTEGER NOT NULL DEFAULT 5,
      base_price        INTEGER NOT NULL DEFAULT 0,
      rush_fee          INTEGER NOT NULL DEFAULT 0,
      quoted_total      INTEGER NOT NULL DEFAULT 0,
      deposit_amount    INTEGER,
      remaining_amount  INTEGER,
      payment_mode      TEXT NOT NULL DEFAULT 'FULL',
      submission_id     TEXT,
      status            TEXT NOT NULL DEFAULT 'RECEIVED',
      expires_at        TEXT NOT NULL,
      created_at        TEXT NOT NULL,
      updated_at        TEXT NOT NULL
    );
  `);

  db.run(`CREATE INDEX IF NOT EXISTS idx_booking_customer ON booking_requests(customer_id);`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_booking_status   ON booking_requests(status);`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_booking_idem     ON booking_requests(idempotency_key);`);

  db.run(`
    CREATE TABLE IF NOT EXISTS jobs (
      job_id                  TEXT PRIMARY KEY,
      job_code                TEXT NOT NULL UNIQUE,
      booking_id              TEXT NOT NULL UNIQUE REFERENCES booking_requests(booking_id),
      customer_id             TEXT NOT NULL REFERENCES customers(customer_id),
      service_type            TEXT NOT NULL,
      rush                    INTEGER NOT NULL DEFAULT 0,
      rush_type               TEXT NOT NULL DEFAULT 'NO_RUSH',
      resolved_city           TEXT NOT NULL DEFAULT '',
      raw_address             TEXT NOT NULL DEFAULT '',
      price_version           INTEGER NOT NULL,
      quoted_total            INTEGER NOT NULL,
      deposit_amount          INTEGER,
      remaining_amount        INTEGER,
      payment_mode            TEXT NOT NULL,
      status                  TEXT NOT NULL DEFAULT 'PAYMENT_PENDING',
      assigned_contractor_id  TEXT,
      scheduled_at            TEXT,
      started_at              TEXT,
      completed_at            TEXT,
      dispatch_attempts       INTEGER NOT NULL DEFAULT 0,
      created_at              TEXT NOT NULL,
      updated_at              TEXT NOT NULL
    );
  `);

  db.run(`CREATE INDEX IF NOT EXISTS idx_jobs_job_code ON jobs(job_code);`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_jobs_status   ON jobs(status);`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_jobs_customer ON jobs(customer_id);`);

  db.run(`
    CREATE TABLE IF NOT EXISTS payments (
      payment_id        TEXT PRIMARY KEY,
      job_id            TEXT REFERENCES jobs(job_id),
      booking_id        TEXT NOT NULL REFERENCES booking_requests(booking_id),
      customer_id       TEXT NOT NULL REFERENCES customers(customer_id),
      payment_type      TEXT NOT NULL,
      amount            INTEGER NOT NULL,
      currency          TEXT NOT NULL DEFAULT 'USD',
      status            TEXT NOT NULL DEFAULT 'PENDING',
      payment_event_id  TEXT NOT NULL UNIQUE,
      processor_ref     TEXT,
      created_at        TEXT NOT NULL,
      updated_at        TEXT NOT NULL
    );
  `);

  db.run(`CREATE INDEX IF NOT EXISTS idx_payments_booking ON payments(booking_id);`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_payments_job     ON payments(job_id);`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_payments_event   ON payments(payment_event_id);`);

  db.run(`
    CREATE TABLE IF NOT EXISTS dispatch_attempts (
      attempt_id      TEXT PRIMARY KEY,
      job_id          TEXT NOT NULL REFERENCES jobs(job_id),
      contractor_id   TEXT NOT NULL,
      attempt_number  INTEGER NOT NULL,
      offered_at      TEXT NOT NULL,
      expires_at      TEXT NOT NULL,
      response        TEXT,
      responded_at    TEXT,
      lock_acquired   INTEGER NOT NULL DEFAULT 0,
      created_at      TEXT NOT NULL,
      UNIQUE (job_id, attempt_number)
    );
  `);

  db.run(`CREATE INDEX IF NOT EXISTS idx_dispatch_job        ON dispatch_attempts(job_id);`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_dispatch_contractor ON dispatch_attempts(contractor_id);`);

  db.run(`
    CREATE TABLE IF NOT EXISTS webhook_events (
      webhook_event_id  TEXT PRIMARY KEY,
      event_type        TEXT NOT NULL,
      raw_body          TEXT NOT NULL,
      signature         TEXT NOT NULL DEFAULT '',
      processed_at      TEXT,
      outcome           TEXT,
      created_at        TEXT NOT NULL
    );
  `);
}

// ── Postgres schema ──────────────────────────────────────────

const PG_SCHEMA = `
CREATE TABLE IF NOT EXISTS customers (
  customer_id   TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL,
  phone         TEXT,
  email_lower   TEXT NOT NULL UNIQUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS booking_requests (
  booking_id        TEXT PRIMARY KEY,
  customer_id       TEXT NOT NULL REFERENCES customers(customer_id),
  idempotency_key   TEXT NOT NULL UNIQUE,
  service_type      TEXT NOT NULL,
  rush              INTEGER NOT NULL DEFAULT 0,
  rush_type         TEXT NOT NULL DEFAULT 'NO_RUSH',
  raw_address       TEXT NOT NULL,
  resolved_city     TEXT,
  resolved_zip      TEXT,
  area_status       TEXT NOT NULL DEFAULT 'IN_AREA',
  price_version     INTEGER NOT NULL DEFAULT 5,
  base_price        INTEGER NOT NULL DEFAULT 0,
  rush_fee          INTEGER NOT NULL DEFAULT 0,
  quoted_total      INTEGER NOT NULL DEFAULT 0,
  deposit_amount    INTEGER,
  remaining_amount  INTEGER,
  payment_mode      TEXT NOT NULL DEFAULT 'FULL',
  submission_id     TEXT,
  status            TEXT NOT NULL DEFAULT 'RECEIVED',
  expires_at        TIMESTAMPTZ NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_booking_customer ON booking_requests(customer_id);
CREATE INDEX IF NOT EXISTS idx_booking_status   ON booking_requests(status);
CREATE INDEX IF NOT EXISTS idx_booking_idem     ON booking_requests(idempotency_key);

CREATE TABLE IF NOT EXISTS jobs (
  job_id                  TEXT PRIMARY KEY,
  job_code                TEXT NOT NULL UNIQUE,
  booking_id              TEXT NOT NULL UNIQUE REFERENCES booking_requests(booking_id),
  customer_id             TEXT NOT NULL REFERENCES customers(customer_id),
  service_type            TEXT NOT NULL,
  rush                    INTEGER NOT NULL DEFAULT 0,
  rush_type               TEXT NOT NULL DEFAULT 'NO_RUSH',
  resolved_city           TEXT NOT NULL DEFAULT '',
  raw_address             TEXT NOT NULL DEFAULT '',
  price_version           INTEGER NOT NULL,
  quoted_total            INTEGER NOT NULL,
  deposit_amount          INTEGER,
  remaining_amount        INTEGER,
  payment_mode            TEXT NOT NULL,
  status                  TEXT NOT NULL DEFAULT 'PAYMENT_PENDING',
  assigned_contractor_id  TEXT,
  scheduled_at            TIMESTAMPTZ,
  started_at              TIMESTAMPTZ,
  completed_at            TIMESTAMPTZ,
  dispatch_attempts       INTEGER NOT NULL DEFAULT 0,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_jobs_job_code ON jobs(job_code);
CREATE INDEX IF NOT EXISTS idx_jobs_status   ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_customer ON jobs(customer_id);

CREATE TABLE IF NOT EXISTS payments (
  payment_id        TEXT PRIMARY KEY,
  job_id            TEXT REFERENCES jobs(job_id),
  booking_id        TEXT NOT NULL REFERENCES booking_requests(booking_id),
  customer_id       TEXT NOT NULL REFERENCES customers(customer_id),
  payment_type      TEXT NOT NULL,
  amount            INTEGER NOT NULL,
  currency          TEXT NOT NULL DEFAULT 'USD',
  status            TEXT NOT NULL DEFAULT 'PENDING',
  payment_event_id  TEXT NOT NULL UNIQUE,
  processor_ref     TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payments_booking ON payments(booking_id);
CREATE INDEX IF NOT EXISTS idx_payments_job     ON payments(job_id);
CREATE INDEX IF NOT EXISTS idx_payments_event   ON payments(payment_event_id);

CREATE TABLE IF NOT EXISTS dispatch_attempts (
  attempt_id      TEXT PRIMARY KEY,
  job_id          TEXT NOT NULL REFERENCES jobs(job_id),
  contractor_id   TEXT NOT NULL,
  attempt_number  INTEGER NOT NULL,
  offered_at      TIMESTAMPTZ NOT NULL,
  expires_at      TIMESTAMPTZ NOT NULL,
  response        TEXT,
  responded_at    TIMESTAMPTZ,
  lock_acquired   INTEGER NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (job_id, attempt_number)
);

CREATE INDEX IF NOT EXISTS idx_dispatch_job        ON dispatch_attempts(job_id);
CREATE INDEX IF NOT EXISTS idx_dispatch_contractor ON dispatch_attempts(contractor_id);

CREATE TABLE IF NOT EXISTS webhook_events (
  webhook_event_id  TEXT PRIMARY KEY,
  event_type        TEXT NOT NULL,
  raw_body          TEXT NOT NULL,
  signature         TEXT NOT NULL DEFAULT '',
  processed_at      TIMESTAMPTZ,
  outcome           TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`;

// ── Factory ──────────────────────────────────────────────────

// pgAdapter is exported so repositories can use it when in Postgres mode
export let pgAdapter: PgAdapter | null = null;

export async function createDatabase(): Promise<Database> {
  const databaseUrl = process.env.DATABASE_URL;

  // Only activate Postgres when DATABASE_URL is a Postgres connection string.
  // Silently fall back to SQLite for MySQL/other URLs (e.g. sandbox env vars).
  const isPostgres = databaseUrl &&
    (databaseUrl.startsWith('postgres://') || databaseUrl.startsWith('postgresql://'));

  if (isPostgres) {
    console.log('[DB] Connecting to Postgres...');
    const adapter = await createPostgresAdapter(databaseUrl);
    pgAdapter = adapter;

    // Apply schema statement by statement
    const stmts = PG_SCHEMA.split(';').map(s => s.trim()).filter(Boolean);
    for (const stmt of stmts) {
      await adapter.run(stmt);
    }
    console.log('[DB] Postgres schema applied.');

    // Return a dummy sql.js Database object — repositories that use pgAdapter
    // will bypass it. Repositories that don't yet support Postgres will fall back
    // to SQLite helpers (which won't be called in Postgres mode).
    const SQL = await initSqlJs();
    return new SQL.Database(); // empty, not used when pgAdapter is set
  }

  console.log('[DB] No DATABASE_URL — using in-memory SQLite.');
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  applySchema(db);
  return db;
}
