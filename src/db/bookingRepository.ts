// ============================================================
// Assembly Concierge MVP v3 — Booking Repository
//
// Postgres-aware + sql.js fallback
//
// Notes:
// - sql.js returns snake_case column names from getAsObject()
// - Postgres adapter also returns snake_case because SQL selects DB columns directly
// - Normalization to camelCase happens only at the return boundary
// - Server-side pricing only — client totals are ignored
// ============================================================

import type { Database } from 'sql.js';
import { dbGet, dbRun, now, pgAdapter } from './database.js';
import type {
  Customer,
  BookingRequest,
  BookingRequestStatus,
  ServiceType,
  PaymentMode,
  AreaStatus,
} from '../domain/types.js';
import { generateId } from '../domain/identifiers.js';
import { computePrice, CURRENT_PRICE_VERSION } from '../domain/pricing.js';
import { transitionBooking } from '../domain/stateMachine.js';

export interface CreateBookingInput {
  idempotencyKey: string;
  name: string;
  email: string;
  phone: string;
  serviceType: ServiceType;
  rush: boolean;
  rawAddress: string;
  resolvedCity: string | null;
  resolvedZip: string | null;
  areaStatus: AreaStatus;
  paymentMode: PaymentMode;
}

export interface CreateBookingResult {
  booking: BookingRequest;
  customer: Customer;
  created: boolean;
}

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

// ── Customer Upsert ──────────────────────────────────────────

async function upsertCustomer(
  db: Database,
  name: string,
  email: string,
  phone: string,
): Promise<Customer> {
  const emailLower = email.toLowerCase().trim();
  const ts = now();

  const existing = await get<any>(
    db,
    `SELECT * FROM customers WHERE email_lower = ?`,
    [emailLower],
  );

  if (existing) {
    await run(
      db,
      `UPDATE customers SET name = ?, phone = ?, updated_at = ? WHERE customer_id = ?`,
      [name, phone, ts, existing.customer_id],
    );

    return {
      customerId: existing.customer_id,
      name,
      email: existing.email,
      phone,
      emailLower,
      createdAt: existing.created_at,
      updatedAt: ts,
    };
  }

  const customerId = generateId();

  await run(
    db,
    `
    INSERT INTO customers (customer_id, name, email, phone, email_lower, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
    [customerId, name, email, phone, emailLower, ts, ts],
  );

  return {
    customerId,
    name,
    email,
    phone,
    emailLower,
    createdAt: ts,
    updatedAt: ts,
  };
}

// ── Booking Creation ─────────────────────────────────────────

export async function createBooking(
  db: Database,
  input: CreateBookingInput,
): Promise<CreateBookingResult> {
  const existing = await get<any>(
    db,
    `
    SELECT
      b.*,
      c.name AS c_name,
      c.email AS c_email,
      c.phone AS c_phone,
      c.email_lower AS c_email_lower,
      c.created_at AS c_created_at,
      c.updated_at AS c_updated_at
    FROM booking_requests b
    JOIN customers c ON b.customer_id = c.customer_id
    WHERE b.idempotency_key = ?
    `,
    [input.idempotencyKey],
  );

  if (existing) {
    return {
      booking: normalizeBooking(existing),
      customer: {
        customerId: existing.customer_id,
        name: existing.c_name,
        email: existing.c_email,
        phone: existing.c_phone,
        emailLower: existing.c_email_lower,
        createdAt: existing.c_created_at,
        updatedAt: existing.c_updated_at,
      },
      created: false,
    };
  }

  const customer = await upsertCustomer(db, input.name, input.email, input.phone);
  const bookingId = generateId();
  const ts = now();
  const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();

  let basePrice = 0;
  let rushFee = 0;
  let quotedTotal = 0;
  let depositAmount: number | null = null;
  let status: BookingRequestStatus = 'RECEIVED';
  const priceVersion = CURRENT_PRICE_VERSION;

  if (input.areaStatus === 'OUTSIDE_AREA') {
    status = 'RECEIVED';
  } else if (input.serviceType === 'CUSTOM') {
    status = 'AWAITING_QUOTE';
  } else {
    const pricing = computePrice(input.serviceType, input.rush, priceVersion);
    basePrice = pricing.basePrice;
    rushFee = pricing.rushFee;
    quotedTotal = pricing.quotedTotal;
    depositAmount = input.paymentMode === 'DEPOSIT' ? pricing.depositAmount : null;
    status = 'PRICED';
  }

  if (pgAdapter) {
    const inserted = await pgAdapter.query(
      `
      INSERT INTO booking_requests (
        booking_id, customer_id, idempotency_key, service_type, rush,
        raw_address, resolved_city, resolved_zip, area_status,
        price_version, base_price, rush_fee, quoted_total, deposit_amount,
        payment_mode, status, expires_at, created_at, updated_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9,
        $10, $11, $12, $13, $14, $15, $16, $17, $18, $19
      )
      ON CONFLICT (idempotency_key) DO NOTHING
      RETURNING booking_id
      `,
      [
        bookingId,
        customer.customerId,
        input.idempotencyKey,
        input.serviceType,
        input.rush ? 1 : 0,
        input.rawAddress,
        input.resolvedCity,
        input.resolvedZip,
        input.areaStatus,
        priceVersion,
        basePrice,
        rushFee,
        quotedTotal,
        depositAmount,
        input.paymentMode,
        status,
        expiresAt,
        ts,
        ts,
      ],
    );

    if (inserted.length === 0) {
      const race = await get<any>(
        db,
        `
        SELECT
          b.*,
          c.name AS c_name,
          c.email AS c_email,
          c.phone AS c_phone,
          c.email_lower AS c_email_lower,
          c.created_at AS c_created_at,
          c.updated_at AS c_updated_at
        FROM booking_requests b
        JOIN customers c ON b.customer_id = c.customer_id
        WHERE b.idempotency_key = ?
        `,
        [input.idempotencyKey],
      );

      if (!race) {
        throw new Error('Booking race detected but existing booking could not be fetched');
      }

      return {
        booking: normalizeBooking(race),
        customer: {
          customerId: race.customer_id,
          name: race.c_name,
          email: race.c_email,
          phone: race.c_phone,
          emailLower: race.c_email_lower,
          createdAt: race.c_created_at,
          updatedAt: race.c_updated_at,
        },
        created: false,
      };
    }
  } else {
    dbRun(
      db,
      `
      INSERT OR IGNORE INTO booking_requests (
        booking_id, customer_id, idempotency_key, service_type, rush,
        raw_address, resolved_city, resolved_zip, area_status,
        price_version, base_price, rush_fee, quoted_total, deposit_amount,
        payment_mode, status, expires_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        bookingId,
        customer.customerId,
        input.idempotencyKey,
        input.serviceType,
        input.rush ? 1 : 0,
        input.rawAddress,
        input.resolvedCity,
        input.resolvedZip,
        input.areaStatus,
        priceVersion,
        basePrice,
        rushFee,
        quotedTotal,
        depositAmount,
        input.paymentMode,
        status,
        expiresAt,
        ts,
        ts,
      ],
    );

    const row = dbGet<any>(
      db,
      `SELECT * FROM booking_requests WHERE booking_id = ?`,
      [bookingId],
    );

    if (!row) {
      const race = await get<any>(
        db,
        `
        SELECT
          b.*,
          c.name AS c_name,
          c.email AS c_email,
          c.phone AS c_phone,
          c.email_lower AS c_email_lower,
          c.created_at AS c_created_at,
          c.updated_at AS c_updated_at
        FROM booking_requests b
        JOIN customers c ON b.customer_id = c.customer_id
        WHERE b.idempotency_key = ?
        `,
        [input.idempotencyKey],
      );

      if (!race) {
        throw new Error('Booking insert failed and existing booking could not be fetched');
      }

      return {
        booking: normalizeBooking(race),
        customer: {
          customerId: race.customer_id,
          name: race.c_name,
          email: race.c_email,
          phone: race.c_phone,
          emailLower: race.c_email_lower,
          createdAt: race.c_created_at,
          updatedAt: race.c_updated_at,
        },
        created: false,
      };
    }
  }

  const row = await get<any>(
    db,
    `SELECT * FROM booking_requests WHERE booking_id = ?`,
    [bookingId],
  );

  if (!row) {
    throw new Error(`Booking created but could not be fetched: ${bookingId}`);
  }

  return {
    booking: normalizeBooking(row),
    customer,
    created: true,
  };
}

// ── Status Update ────────────────────────────────────────────

export async function updateBookingStatus(
  db: Database,
  bookingId: string,
  newStatus: BookingRequestStatus,
): Promise<void> {
  const row = await get<any>(
    db,
    `SELECT status FROM booking_requests WHERE booking_id = ?`,
    [bookingId],
  );

  if (!row) {
    throw new Error(`Booking not found: ${bookingId}`);
  }

  transitionBooking(row.status as BookingRequestStatus, newStatus);

  await run(
    db,
    `UPDATE booking_requests SET status = ?, updated_at = ? WHERE booking_id = ?`,
    [newStatus, now(), bookingId],
  );
}

// ── Fetch ────────────────────────────────────────────────────

export async function getBookingById(
  db: Database,
  bookingId: string,
): Promise<BookingRequest | undefined> {
  const row = await get<any>(
    db,
    `SELECT * FROM booking_requests WHERE booking_id = ?`,
    [bookingId],
  );

  return row ? normalizeBooking(row) : undefined;
}

// ── Normalization ────────────────────────────────────────────

export function normalizeBooking(row: any): BookingRequest {
  return {
    bookingId: row.booking_id,
    customerId: row.customer_id,
    idempotencyKey: row.idempotency_key,
    serviceType: row.service_type,
    rush: row.rush === 1 || row.rush === true,
    rawAddress: row.raw_address,
    resolvedCity: row.resolved_city ?? null,
    resolvedZip: row.resolved_zip ?? null,
    areaStatus: row.area_status,
    priceVersion: row.price_version,
    basePrice: row.base_price,
    rushFee: row.rush_fee,
    quotedTotal: row.quoted_total,
    depositAmount: row.deposit_amount ?? null,
    paymentMode: row.payment_mode,
    status: row.status,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
