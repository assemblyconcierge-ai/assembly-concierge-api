// ============================================================
// Assembly Concierge MVP v3 — Payment & Job Repository
//
// Postgres-aware + sql.js fallback
//
// Handles:
// - payment intent creation
// - webhook processing
// - job creation (with job_code)
// - dispatch attempt management
// - webhook replay
// ============================================================

import type { Database } from 'sql.js';
import { dbGet, dbRun, dbAll, dbChanges, now, pgAdapter } from './database.js';
import type { Job, Payment, DispatchAttempt, JobStatus } from '../domain/types.js';
import { generateId, generatePublicJobCode } from '../domain/identifiers.js';
import { verifyPaymentAmount } from '../domain/pricing.js';
import { transitionJob } from '../domain/stateMachine.js';
import { updateBookingStatus } from './bookingRepository.js';

// ── Internal DB Helpers ──────────────────────────────────────

async function run(db: Database, sql: string, params: any[] = []): Promise<void> {
  if (pgAdapter) {
    await pgAdapter.run(sql, params);
    return;
  }
  dbRun(db, sql, params);
}

async function get<T>(db: Database, sql: string, params: any[] = []): Promise<T | undefined> {
  if (pgAdapter) {
    const row = await pgAdapter.queryOne(sql, params);
    return (row ?? undefined) as T | undefined;
  }
  return dbGet<T>(db, sql, params);
}

async function all<T>(db: Database, sql: string, params: any[] = []): Promise<T[]> {
  if (pgAdapter) {
    const rows = await pgAdapter.query(sql, params);
    return rows as T[];
  }
  return dbAll<T>(db, sql, params);
}

async function changesAfterUpdate(db: Database, sql: string, params: any[] = []): Promise<number> {
  if (pgAdapter) {
    const result = await pgAdapter.query(
      `${sql} RETURNING 1`,
      params,
    );
    return result.length;
  }
  dbRun(db, sql, params);
  return dbChanges(db);
}

// ── Payment Intent ───────────────────────────────────────────

export interface CreatePaymentIntentInput {
  bookingId: string;
  customerId: string;
  paymentType: 'FULL' | 'DEPOSIT';
  amount: number;
  paymentEventId: string;
}

export interface CreatePaymentIntentResult {
  paymentId: string;
  amount: number;
  currency: string;
  status: string;
  paymentEventId: string;
}

export async function createPaymentIntent(
  db: Database,
  input: CreatePaymentIntentInput,
): Promise<CreatePaymentIntentResult> {
  const existing = await get<any>(
    db,
    `SELECT * FROM payments WHERE payment_event_id = ?`,
    [input.paymentEventId],
  );

  if (existing) {
    return {
      paymentId: existing.payment_id,
      amount: existing.amount,
      currency: existing.currency,
      status: existing.status,
      paymentEventId: existing.payment_event_id,
    };
  }

  const paymentId = generateId();
  const ts = now();

  await run(
    db,
    `
    INSERT INTO payments (
      payment_id, job_id, booking_id, customer_id, payment_type,
      amount, currency, status, payment_event_id, processor_ref,
      created_at, updated_at
    ) VALUES (?, NULL, ?, ?, ?, ?, 'USD', 'PENDING', ?, NULL, ?, ?)
    `,
    [
      paymentId,
      input.bookingId,
      input.customerId,
      input.paymentType,
      input.amount,
      input.paymentEventId,
      ts,
      ts,
    ],
  );

  const bookingRow = await get<any>(
    db,
    `SELECT status FROM booking_requests WHERE booking_id = ?`,
    [input.bookingId],
  );

  if (bookingRow && bookingRow.status === 'PRICED') {
    await run(
      db,
      `UPDATE booking_requests SET status = 'AWAITING_PAYMENT', updated_at = ? WHERE booking_id = ?`,
      [ts, input.bookingId],
    );
  }

  return {
    paymentId,
    amount: input.amount,
    currency: 'USD',
    status: 'PENDING',
    paymentEventId: input.paymentEventId,
  };
}

// ── Webhook Processing ───────────────────────────────────────

export interface WebhookPayload {
  webhookEventId: string;
  paymentEventId: string;
  eventType: string;
  amount: number;
  currency: string;
  bookingId?: string;
}

export type WebhookOutcome =
  | 'SUCCESS'
  | 'DUPLICATE'
  | 'PRICE_MISMATCH'
  | 'OUTSIDE_AREA'
  | 'BOOKING_NOT_FOUND'
  | 'PAYMENT_NOT_FOUND'
  | 'ALREADY_PROCESSED';

export interface ProcessWebhookResult {
  outcome: WebhookOutcome;
  jobId?: string;
  jobCode?: string;
  bookingId?: string;
}

export async function processWebhook(
  db: Database,
  payload: WebhookPayload,
  rawBody: string,
  signature: string,
): Promise<ProcessWebhookResult> {
  const existingEvent = await get<any>(
    db,
    `SELECT * FROM webhook_events WHERE webhook_event_id = ?`,
    [payload.webhookEventId],
  );

  if (existingEvent?.processed_at) {
    return { outcome: 'DUPLICATE' };
  }

  if (!existingEvent) {
    const ts = now();
    await run(
      db,
      `
      INSERT INTO webhook_events (webhook_event_id, event_type, raw_body, signature, created_at)
      VALUES (?, ?, ?, ?, ?)
      `,
      [payload.webhookEventId, payload.eventType, rawBody, signature, ts],
    );
  }

  const payment = await get<any>(
    db,
    `SELECT * FROM payments WHERE payment_event_id = ?`,
    [payload.paymentEventId],
  );

  if (!payment) {
    return { outcome: 'PAYMENT_NOT_FOUND' };
  }

  const bookingId = payment.booking_id;

  const booking = await get<any>(
    db,
    `SELECT * FROM booking_requests WHERE booking_id = ?`,
    [bookingId],
  );

  if (!booking) {
    return { outcome: 'BOOKING_NOT_FOUND' };
  }

  if (booking.area_status === 'OUTSIDE_AREA') {
    return { outcome: 'OUTSIDE_AREA' };
  }

  const expectedAmount =
    payment.payment_type === 'DEPOSIT'
      ? booking.deposit_amount
      : booking.quoted_total;

  const priceCheck = verifyPaymentAmount(expectedAmount, payload.amount);

  if (!priceCheck.ok) {
    await run(
      db,
      `UPDATE webhook_events SET processed_at = ?, outcome = ? WHERE webhook_event_id = ?`,
      [now(), 'PRICE_MISMATCH', payload.webhookEventId],
    );
    return { outcome: 'PRICE_MISMATCH' };
  }

  const existingJob = await get<any>(
    db,
    `SELECT * FROM jobs WHERE booking_id = ?`,
    [bookingId],
  );

  if (existingJob) {
    await run(
      db,
      `UPDATE payments SET job_id = ?, status = 'SUCCEEDED', updated_at = ? WHERE payment_id = ?`,
      [existingJob.job_id, now(), payment.payment_id],
    );

    await run(
      db,
      `UPDATE webhook_events SET processed_at = ?, outcome = ? WHERE webhook_event_id = ?`,
      [now(), 'DUPLICATE', payload.webhookEventId],
    );

    return {
      outcome: 'DUPLICATE',
      jobId: existingJob.job_id,
      jobCode: existingJob.job_code,
      bookingId,
    };
  }

  const jobId = generateId();
  let jobCode = generatePublicJobCode();

  let attempts = 0;
  while (attempts < 5) {
    const collision = await get<any>(
      db,
      `SELECT job_id FROM jobs WHERE job_code = ?`,
      [jobCode],
    );
    if (!collision) break;
    jobCode = generatePublicJobCode();
    attempts++;
  }

  const jobStatus: JobStatus =
    payment.payment_type === 'DEPOSIT' ? 'PAID_DEPOSIT' : 'PAID_FULL';

  const ts = now();

  if (pgAdapter) {
    const inserted = await pgAdapter.query(
      `
      INSERT INTO jobs (
        job_id, job_code, booking_id, customer_id, service_type, rush,
        resolved_city, raw_address, price_version, quoted_total, deposit_amount,
        payment_mode, status, assigned_contractor_id, dispatch_attempts,
        created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NULL, 0, $14, $15)
      ON CONFLICT (booking_id) DO NOTHING
      RETURNING job_id, job_code
      `,
      [
        jobId,
        jobCode,
        bookingId,
        booking.customer_id,
        booking.service_type,
        booking.rush,
        booking.resolved_city ?? '',
        booking.raw_address,
        booking.price_version,
        booking.quoted_total,
        booking.deposit_amount,
        booking.payment_mode,
        jobStatus,
        ts,
        ts,
      ],
    );

    if (inserted.length === 0) {
      const raceJob = await get<any>(
        db,
        `SELECT * FROM jobs WHERE booking_id = ?`,
        [bookingId],
      );

      await run(
        db,
        `UPDATE webhook_events SET processed_at = ?, outcome = ? WHERE webhook_event_id = ?`,
        [now(), 'DUPLICATE', payload.webhookEventId],
      );

      return {
        outcome: 'DUPLICATE',
        jobId: raceJob?.job_id,
        jobCode: raceJob?.job_code,
        bookingId,
      };
    }
  } else {
    dbRun(
      db,
      `
      INSERT OR IGNORE INTO jobs (
        job_id, job_code, booking_id, customer_id, service_type, rush,
        resolved_city, raw_address, price_version, quoted_total, deposit_amount,
        payment_mode, status, assigned_contractor_id, dispatch_attempts,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, ?, ?)
      `,
      [
        jobId,
        jobCode,
        bookingId,
        booking.customer_id,
        booking.service_type,
        booking.rush,
        booking.resolved_city ?? '',
        booking.raw_address,
        booking.price_version,
        booking.quoted_total,
        booking.deposit_amount,
        booking.payment_mode,
        jobStatus,
        ts,
        ts,
      ],
    );

    const changes = dbChanges(db);
    if (changes === 0) {
      const raceJob = dbGet<any>(db, `SELECT * FROM jobs WHERE booking_id = ?`, [bookingId])!;

      dbRun(
        db,
        `UPDATE webhook_events SET processed_at = ?, outcome = ? WHERE webhook_event_id = ?`,
        [now(), 'DUPLICATE', payload.webhookEventId],
      );

      return {
        outcome: 'DUPLICATE',
        jobId: raceJob.job_id,
        jobCode: raceJob.job_code,
        bookingId,
      };
    }
  }

  await run(
    db,
    `UPDATE payments SET job_id = ?, status = 'SUCCEEDED', updated_at = ? WHERE payment_id = ?`,
    [jobId, now(), payment.payment_id],
  );

  await updateBookingStatus(db, bookingId, 'CONVERTED');

  await run(
    db,
    `UPDATE webhook_events SET processed_at = ?, outcome = ? WHERE webhook_event_id = ?`,
    [now(), 'SUCCESS', payload.webhookEventId],
  );

  return { outcome: 'SUCCESS', jobId, jobCode, bookingId };
}

// ── Webhook Replay ───────────────────────────────────────────

export interface ReplayWebhookResult {
  replayed: boolean;
  outcome: WebhookOutcome | 'NOT_FOUND';
  jobId?: string;
  jobCode?: string;
}

export async function replayWebhook(
  db: Database,
  webhookEventId: string,
): Promise<ReplayWebhookResult> {
  const event = await get<any>(
    db,
    `SELECT * FROM webhook_events WHERE webhook_event_id = ?`,
    [webhookEventId],
  );

  if (!event) return { replayed: false, outcome: 'NOT_FOUND' };

  if (event.processed_at) {
    let jobId: string | undefined;
    let jobCode: string | undefined;

    try {
      const body = JSON.parse(event.raw_body);
      const payment = await get<any>(
        db,
        `SELECT * FROM payments WHERE payment_event_id = ?`,
        [body.paymentEventId],
      );

      if (payment?.job_id) {
        const job = await get<any>(
          db,
          `SELECT job_id, job_code FROM jobs WHERE job_id = ?`,
          [payment.job_id],
        );
        if (job) {
          jobId = job.job_id;
          jobCode = job.job_code;
        }
      }
    } catch {
      // ignore malformed replay body
    }

    return { replayed: true, outcome: 'DUPLICATE', jobId, jobCode };
  }

  let payload: WebhookPayload;
  try {
    const body = JSON.parse(event.raw_body);
    payload = {
      webhookEventId: event.webhook_event_id,
      paymentEventId: body.paymentEventId,
      eventType: event.event_type,
      amount: body.amount,
      currency: body.currency ?? 'USD',
      bookingId: body.bookingId,
    };
  } catch {
    return { replayed: false, outcome: 'NOT_FOUND' };
  }

  const result = await processWebhook(db, payload, event.raw_body, event.signature ?? '');
  return {
    replayed: true,
    outcome: result.outcome,
    jobId: result.jobId,
    jobCode: result.jobCode,
  };
}

// ── Job Fetch ────────────────────────────────────────────────

export async function getJobByBookingId(
  db: Database,
  bookingId: string,
): Promise<Job | undefined> {
  const row = await get<any>(db, `SELECT * FROM jobs WHERE booking_id = ?`, [bookingId]);
  return row ? normalizeJob(row) : undefined;
}

export async function getJobById(
  db: Database,
  jobId: string,
): Promise<Job | undefined> {
  const row = await get<any>(db, `SELECT * FROM jobs WHERE job_id = ?`, [jobId]);
  return row ? normalizeJob(row) : undefined;
}

export async function getJobByCode(
  db: Database,
  jobCode: string,
): Promise<Job | undefined> {
  const row = await get<any>(db, `SELECT * FROM jobs WHERE job_code = ?`, [jobCode]);
  return row ? normalizeJob(row) : undefined;
}

// ── Job Status Update ────────────────────────────────────────

export async function updateJobStatus(
  db: Database,
  jobId: string,
  newStatus: JobStatus,
): Promise<void> {
  const row = await get<any>(db, `SELECT status FROM jobs WHERE job_id = ?`, [jobId]);
  if (!row) throw new Error(`Job not found: ${jobId}`);

  transitionJob(row.status as JobStatus, newStatus);

  await run(
    db,
    `UPDATE jobs SET status = ?, updated_at = ? WHERE job_id = ?`,
    [newStatus, now(), jobId],
  );
}

// ── Dispatch Engine ──────────────────────────────────────────

export interface OfferDispatchInput {
  jobId: string;
  contractorId: string;
  timeoutMinutes?: number;
}

export async function offerDispatch(
  db: Database,
  input: OfferDispatchInput,
): Promise<DispatchAttempt> {
  const job = await get<any>(db, `SELECT * FROM jobs WHERE job_id = ?`, [input.jobId]);
  if (!job) throw new Error(`Job not found: ${input.jobId}`);

  const attemptNumber = (job.dispatch_attempts ?? 0) + 1;
  const attemptId = generateId();
  const ts = now();
  const timeoutMs = (input.timeoutMinutes ?? 15) * 60 * 1000;
  const expiresAt = new Date(Date.now() + timeoutMs).toISOString();

  await run(
    db,
    `
    INSERT INTO dispatch_attempts (
      attempt_id, job_id, contractor_id, attempt_number,
      offered_at, expires_at, response, responded_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?)
    `,
    [attemptId, input.jobId, input.contractorId, attemptNumber, ts, expiresAt, ts],
  );

  const currentStatus = job.status as JobStatus;

  if (currentStatus !== 'DISPATCHING') {
    transitionJob(currentStatus, 'DISPATCHING');
    await run(
      db,
      `UPDATE jobs SET status = 'DISPATCHING', dispatch_attempts = ?, updated_at = ? WHERE job_id = ?`,
      [attemptNumber, now(), input.jobId],
    );
  } else {
    await run(
      db,
      `UPDATE jobs SET dispatch_attempts = ?, updated_at = ? WHERE job_id = ?`,
      [attemptNumber, now(), input.jobId],
    );
  }

  return {
    attemptId,
    jobId: input.jobId,
    contractorId: input.contractorId,
    attemptNumber,
    offeredAt: ts,
    expiresAt,
    response: null,
    respondedAt: null,
    createdAt: ts,
  };
}

export interface RespondDispatchResult {
  outcome: 'ASSIGNED' | 'DECLINED' | 'ALREADY_ASSIGNED' | 'NOT_FOUND';
  jobCode?: string;
}

export async function respondDispatch(
  db: Database,
  input: { attemptId: string; response: 'ACCEPTED' | 'DECLINED' },
): Promise<RespondDispatchResult> {
  const attempt = await get<any>(
    db,
    `SELECT * FROM dispatch_attempts WHERE attempt_id = ?`,
    [input.attemptId],
  );

  if (!attempt) return { outcome: 'NOT_FOUND' };

  if (attempt.response !== null) {
    return { outcome: attempt.response === 'ACCEPTED' ? 'ASSIGNED' : 'DECLINED' };
  }

  const job = await get<any>(db, `SELECT * FROM jobs WHERE job_id = ?`, [attempt.job_id]);
  if (!job) return { outcome: 'NOT_FOUND' };

  const ts = now();

  if (input.response === 'ACCEPTED') {
    const changed = await changesAfterUpdate(
      db,
      `
      UPDATE jobs
      SET status = 'ASSIGNED', assigned_contractor_id = ?, updated_at = ?
      WHERE job_id = ? AND status = 'DISPATCHING'
      `,
      [attempt.contractor_id, ts, attempt.job_id],
    );

    if (changed === 0) {
      await run(
        db,
        `UPDATE dispatch_attempts SET response = 'DECLINED', responded_at = ? WHERE attempt_id = ?`,
        [ts, input.attemptId],
      );
      return { outcome: 'ALREADY_ASSIGNED' };
    }

    await run(
      db,
      `UPDATE dispatch_attempts SET response = 'ACCEPTED', responded_at = ? WHERE attempt_id = ?`,
      [ts, input.attemptId],
    );

    return { outcome: 'ASSIGNED', jobCode: job.job_code };
  }

  await run(
    db,
    `UPDATE dispatch_attempts SET response = 'DECLINED', responded_at = ? WHERE attempt_id = ?`,
    [ts, input.attemptId],
  );

  if ((job.dispatch_attempts ?? 0) >= 5) {
    await run(
      db,
      `UPDATE jobs SET status = 'DISPATCH_FAILED', updated_at = ? WHERE job_id = ?`,
      [ts, attempt.job_id],
    );
  }

  return { outcome: 'DECLINED' };
}

export async function getDispatchAttempts(
  db: Database,
  jobId: string,
): Promise<DispatchAttempt[]> {
  const rows = await all<any>(
    db,
    `SELECT * FROM dispatch_attempts WHERE job_id = ? ORDER BY attempt_number ASC`,
    [jobId],
  );

  return rows.map((r) => ({
    attemptId: r.attempt_id,
    jobId: r.job_id,
    contractorId: r.contractor_id,
    attemptNumber: r.attempt_number,
    offeredAt: r.offered_at,
    expiresAt: r.expires_at,
    response: r.response ?? null,
    respondedAt: r.responded_at ?? null,
    createdAt: r.created_at,
  }));
}

// ── Normalization ────────────────────────────────────────────

export function normalizeJob(row: any): Job {
  return {
    jobId: row.job_id,
    jobCode: row.job_code,
    bookingId: row.booking_id,
    customerId: row.customer_id,
    serviceType: row.service_type,
    rush: row.rush === 1 || row.rush === true,
    resolvedCity: row.resolved_city ?? '',
    rawAddress: row.raw_address ?? '',
    priceVersion: row.price_version,
    quotedTotal: row.quoted_total,
    depositAmount: row.deposit_amount ?? null,
    paymentMode: row.payment_mode,
    status: row.status,
    assignedContractorId: row.assigned_contractor_id ?? null,
    scheduledAt: row.scheduled_at ?? null,
    startedAt: row.started_at ?? null,
    completedAt: row.completed_at ?? null,
    dispatchAttempts: row.dispatch_attempts ?? 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function normalizePayment(row: any): Payment {
  return {
    paymentId: row.payment_id,
    jobId: row.job_id ?? null,
    bookingId: row.booking_id,
    customerId: row.customer_id,
    paymentType: row.payment_type,
    amount: row.amount,
    currency: row.currency ?? 'USD',
    status: row.status,
    paymentEventId: row.payment_event_id,
    processorRef: row.processor_ref ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
