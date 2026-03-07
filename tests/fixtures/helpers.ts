// ============================================================
// Assembly Concierge MVP v2 — Test Helpers & Fixtures
// ============================================================

import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../../src/app.js';
import { createDatabase } from '../../src/db/database.js';
import { signPayload } from '../../src/lib/webhookSecurity.js';
import { generateIdempotencyKey } from '../../src/domain/identifiers.js';

export const WEBHOOK_SECRET = 'test-secret-key';

// ── App Factory ──────────────────────────────────────────────

export async function buildApp(): Promise<{ app: Express; db: any }> {
  process.env['WEBHOOK_SECRET'] = WEBHOOK_SECRET;
  const db = await createDatabase();
  const app = createApp(db);
  return { app, db };
}

// Legacy alias
export const createTestApp = buildApp;

// ── Booking Helpers ──────────────────────────────────────────

export interface BookingPayload {
  idempotencyKey?: string;
  name?: string;
  email?: string;
  phone?: string;
  serviceType?: string;
  rush?: boolean;
  rawAddress?: string;
  resolvedCity?: string;
  resolvedZip?: string;
  areaStatus?: string;
  paymentMode?: string;
}

export function makeBookingPayload(overrides: BookingPayload = {}): Required<BookingPayload> {
  return {
    idempotencyKey: overrides.idempotencyKey ?? generateIdempotencyKey(),
    name:           overrides.name          ?? 'Jane Smith',
    email:          overrides.email         ?? `jane+${Date.now()}@example.com`,
    phone:          overrides.phone         ?? '512-555-0100',
    serviceType:    overrides.serviceType   ?? 'MEDIUM',
    rush:           overrides.rush          ?? false,
    rawAddress:     overrides.rawAddress    ?? '123 Main St',
    resolvedCity:   overrides.resolvedCity  ?? 'Austin',
    resolvedZip:    overrides.resolvedZip   ?? '78701',
    areaStatus:     overrides.areaStatus    ?? 'IN_AREA',
    paymentMode:    overrides.paymentMode   ?? 'FULL',
  };
}

// Legacy alias
export function buildBookingBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return makeBookingPayload(overrides as BookingPayload);
}

export async function createBooking(
  app: Express,
  overrides: BookingPayload = {},
): Promise<{ bookingId: string; customerId: string; pricing: any; status: string; paymentMode: string }> {
  const payload = makeBookingPayload(overrides);
  const res = await request(app)
    .post('/bookings')
    .send(payload);
  if (res.status !== 200 && res.status !== 201) {
    throw new Error(`createBooking failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body;
}

// ── Payment Intent Helpers ───────────────────────────────────

export async function createPaymentIntent(
  app: Express,
  bookingId: string,
  paymentType: 'FULL' | 'DEPOSIT' = 'FULL',
): Promise<{ paymentId: string; paymentEventId: string; amount: number; status: string }> {
  const res = await request(app)
    .post('/payments/intent')
    .send({ bookingId, paymentType });
  if (res.status !== 200 && res.status !== 201) {
    throw new Error(`createPaymentIntent failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body;
}

// ── Webhook Helpers ──────────────────────────────────────────

export interface WebhookPayload {
  webhookEventId?: string;
  paymentEventId: string;
  eventType?: string;
  amount: number;
  currency?: string;
}

export function makeWebhookPayload(overrides: WebhookPayload): {
  webhookEventId: string;
  paymentEventId: string;
  eventType: string;
  amount: number;
  currency: string;
} {
  return {
    webhookEventId: overrides.webhookEventId ?? generateIdempotencyKey(),
    paymentEventId: overrides.paymentEventId,
    eventType:      overrides.eventType ?? 'payment.succeeded',
    amount:         overrides.amount,
    currency:       overrides.currency ?? 'USD',
  };
}

export async function sendWebhook(
  app: Express,
  payload: WebhookPayload,
  secretOverride?: string,
): Promise<{ status: number; body: any }> {
  const fullPayload = makeWebhookPayload(payload);
  const rawBody = JSON.stringify(fullPayload);
  const secret = secretOverride ?? WEBHOOK_SECRET;
  const signature = signPayload(secret, rawBody);

  const res = await request(app)
    .post('/webhooks/payment')
    .set('Content-Type', 'application/json')
    .set('x-webhook-signature', signature)
    .send(rawBody);  // Send as string — supertest will transmit raw bytes

  return { status: res.status, body: res.body };
}

// Legacy: build a signed webhook body object (for tests that construct manually)
export function buildSucceededWebhook(overrides: Record<string, unknown> = {}): {
  body: Record<string, unknown>;
  signature: string;
} {
  const body: Record<string, unknown> = {
    webhookEventId: generateIdempotencyKey(),
    paymentEventId: generateIdempotencyKey(),
    eventType: 'payment.succeeded',
    amount: 12900,
    currency: 'USD',
    ...overrides,
  };
  const rawBody = JSON.stringify(body);
  const signature = signPayload(WEBHOOK_SECRET, rawBody);
  return { body, signature };
}

// ── Full Flow Helper ─────────────────────────────────────────

export async function runFullPaymentFlow(
  app: Express,
  bookingOverrides: BookingPayload = {},
): Promise<{
  bookingId: string;
  customerId: string;
  paymentEventId: string;
  webhookEventId: string;
  jobId: string;
  jobCode: string;
  amount: number;
}> {
  const booking = await createBooking(app, bookingOverrides);
  const intent = await createPaymentIntent(app, booking.bookingId, 'FULL');
  const webhookEventId = generateIdempotencyKey();

  const webhookResult = await sendWebhook(app, {
    webhookEventId,
    paymentEventId: intent.paymentEventId,
    amount: intent.amount,
  });

  if (webhookResult.body.outcome !== 'SUCCESS') {
    throw new Error(`Webhook failed: ${JSON.stringify(webhookResult.body)}`);
  }

  return {
    bookingId: booking.bookingId,
    customerId: booking.customerId,
    paymentEventId: intent.paymentEventId,
    webhookEventId,
    jobId: webhookResult.body.jobId,
    jobCode: webhookResult.body.jobCode,
    amount: intent.amount,
  };
}
