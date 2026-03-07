// ============================================================
// Assembly Concierge MVP v2 — Integration Tests: API Layer
// Covers acceptance tests AT-01 through AT-28 from v2 spec §10
// ============================================================

import { describe, it, expect, beforeEach } from '@jest/globals';
import request from 'supertest';
import type { Express } from 'express';
import {
  buildApp, createBooking, createPaymentIntent, sendWebhook,
  runFullPaymentFlow, makeBookingPayload, WEBHOOK_SECRET,
} from '../fixtures/helpers.js';
import { generateIdempotencyKey } from '../../src/domain/identifiers.js';

let app: Express;

beforeEach(async () => {
  ({ app } = await buildApp());
});

// ── Health ───────────────────────────────────────────────────

describe('GET /health', () => {
  it('returns 200 with status ok', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });
});

// ── AT-01: Idempotent booking creation ───────────────────────

describe('AT-01: Idempotent booking creation', () => {
  it('returns same bookingId on retry with same idempotencyKey', async () => {
    const payload = makeBookingPayload();
    const r1 = await request(app).post('/bookings').send(payload);
    const r2 = await request(app).post('/bookings').send(payload);
    expect(r1.status).toBe(201);
    expect(r2.status).toBe(200);
    expect(r1.body.bookingId).toBe(r2.body.bookingId);
    expect(r2.body.created).toBe(false);
  });

  it('creates different bookings for different idempotencyKeys', async () => {
    const r1 = await request(app).post('/bookings').send(makeBookingPayload());
    const r2 = await request(app).post('/bookings').send(makeBookingPayload());
    expect(r1.body.bookingId).not.toBe(r2.body.bookingId);
  });
});

// ── AT-02: Server-side pricing enforcement ───────────────────

describe('AT-02: Server-side pricing — client totals ignored', () => {
  it('returns server-computed pricing for MEDIUM', async () => {
    const res = await request(app).post('/bookings').send(
      makeBookingPayload({ serviceType: 'MEDIUM', rush: false })
    );
    expect(res.status).toBe(201);
    expect(res.body.pricing.basePrice).toBe(12900);
    expect(res.body.pricing.rushFee).toBe(0);
    expect(res.body.pricing.quotedTotal).toBe(12900);
  });

  it('adds rush fee server-side when rush=true', async () => {
    const res = await request(app).post('/bookings').send(
      makeBookingPayload({ rush: true })
    );
    expect(res.body.pricing.rushFee).toBe(3000)  // v5: SAME_DAY=$30;
    expect(res.body.pricing.quotedTotal).toBe(15900);
  });

  it('computes deposit as floor(total/2)', async () => {
    const res = await request(app).post('/bookings').send(
      makeBookingPayload({ serviceType: 'MEDIUM', paymentMode: 'DEPOSIT' })
    );
    expect(res.body.pricing.depositAmount).toBe(6450);
  });
});

// ── AT-03: Identity fields in booking response ───────────────

describe('AT-03: Identity fields in booking response', () => {
  it('response includes bookingId, customerId, and pricing', async () => {
    const res = await request(app).post('/bookings').send(makeBookingPayload());
    expect(typeof res.body.bookingId).toBe('string');
    expect(typeof res.body.customerId).toBe('string');
    expect(res.body.pricing).toBeDefined();
    expect(typeof res.body.pricing.quotedTotal).toBe('number');
  });
});

// ── AT-04: Duplicate webhook returns DUPLICATE ───────────────

describe('AT-04: Duplicate webhook idempotency', () => {
  it('second identical webhook returns DUPLICATE outcome', async () => {
    const flow = await runFullPaymentFlow(app);
    const dup = await sendWebhook(app, {
      webhookEventId: flow.webhookEventId,
      paymentEventId: flow.paymentEventId,
      amount: flow.amount,
    });
    expect(dup.body.outcome).toBe('DUPLICATE');
  });
});

// ── AT-05: Job created after successful webhook ───────────────

describe('AT-05: Job creation after payment.succeeded webhook', () => {
  it('creates a job with jobId and jobCode after successful webhook', async () => {
    const flow = await runFullPaymentFlow(app);
    expect(typeof flow.jobId).toBe('string');
    expect(flow.jobCode).toMatch(/^AC-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  });

  it('booking status is CONVERTED after successful webhook', async () => {
    const flow = await runFullPaymentFlow(app);
    const res = await request(app).get(`/bookings/${flow.bookingId}`);
    expect(res.body.status).toBe('CONVERTED');
  });

  it('GET /bookings/:id includes job linkage', async () => {
    const flow = await runFullPaymentFlow(app);
    const res = await request(app).get(`/bookings/${flow.bookingId}`);
    expect(res.body.job).not.toBeNull();
    expect(res.body.job.jobId).toBe(flow.jobId);
    expect(res.body.job.jobCode).toBe(flow.jobCode);
  });
});

// ── AT-06: Job lookup by jobCode ─────────────────────────────

describe('AT-06: Job lookup by public jobCode', () => {
  it('GET /jobs/code/:jobCode returns the job', async () => {
    const flow = await runFullPaymentFlow(app);
    const res = await request(app).get(`/jobs/code/${flow.jobCode}`);
    expect(res.status).toBe(200);
    expect(res.body.jobId).toBe(flow.jobId);
    expect(res.body.jobCode).toBe(flow.jobCode);
  });

  it('GET /jobs/code/:jobCode returns 404 for unknown code', async () => {
    const res = await request(app).get('/jobs/code/AC-ZZZZ-ZZZZ');
    expect(res.status).toBe(404);
  });
});

// ── AT-07: Job lookup by jobId ───────────────────────────────

describe('AT-07: Job lookup by jobId', () => {
  it('GET /jobs/:id returns the job with dispatch history', async () => {
    const flow = await runFullPaymentFlow(app);
    const res = await request(app).get(`/jobs/${flow.jobId}`);
    expect(res.status).toBe(200);
    expect(res.body.jobId).toBe(flow.jobId);
    expect(Array.isArray(res.body.dispatchHistory)).toBe(true);
  });
});

// ── AT-08: Customer dedup by email ───────────────────────────

describe('AT-08: Customer deduplication by email', () => {
  it('same email produces same customerId across bookings', async () => {
    const email = `dedup+${Date.now()}@example.com`;
    const b1 = await createBooking(app, { email });
    const b2 = await createBooking(app, { email });
    expect(b1.customerId).toBe(b2.customerId);
  });

  it('different emails produce different customerIds', async () => {
    const b1 = await createBooking(app, { email: `a${Date.now()}@example.com` });
    const b2 = await createBooking(app, { email: `b${Date.now()}@example.com` });
    expect(b1.customerId).not.toBe(b2.customerId);
  });
});

// ── AT-09: Outside-area payment blocked ──────────────────────

describe('AT-09: Outside-area payment blocked', () => {
  it('POST /payments/intent returns 400 for outside-area booking', async () => {
    const booking = await createBooking(app, { areaStatus: 'OUTSIDE_AREA' });
    const res = await request(app)
      .post('/payments/intent')
      .send({ bookingId: booking.bookingId, paymentType: 'FULL' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('OUTSIDE_AREA');
  });
});

// ── AT-10: Price tamper detection ────────────────────────────

describe('AT-10: Price tamper detection', () => {
  it('webhook with tampered amount returns PRICE_MISMATCH', async () => {
    const booking = await createBooking(app);
    const intent = await createPaymentIntent(app, booking.bookingId);
    const result = await sendWebhook(app, {
      webhookEventId: generateIdempotencyKey(),
      paymentEventId: intent.paymentEventId,
      amount: intent.amount - 5000,
    });
    expect(result.body.outcome).toBe('PRICE_MISMATCH');
  });

  it('no job is created after PRICE_MISMATCH', async () => {
    const booking = await createBooking(app);
    const intent = await createPaymentIntent(app, booking.bookingId);
    await sendWebhook(app, {
      webhookEventId: generateIdempotencyKey(),
      paymentEventId: intent.paymentEventId,
      amount: intent.amount - 1,
    });
    const res = await request(app).get(`/bookings/${booking.bookingId}`);
    expect(res.body.job).toBeNull();
  });
});

// ── AT-11: CUSTOM service type → AWAITING_QUOTE ──────────────

describe('AT-11: CUSTOM service type', () => {
  it('CUSTOM booking has status AWAITING_QUOTE', async () => {
    const booking = await createBooking(app, { serviceType: 'CUSTOM' });
    expect(booking.status).toBe('AWAITING_QUOTE');
  });

  it('CUSTOM booking has zero pricing', async () => {
    const booking = await createBooking(app, { serviceType: 'CUSTOM' });
    expect(booking.pricing.quotedTotal).toBe(0);
  });
});

// ── AT-12: Invalid signature rejected ────────────────────────

describe('AT-12: Invalid webhook signature rejected', () => {
  it('returns 401 for bad signature', async () => {
    const booking = await createBooking(app);
    const intent = await createPaymentIntent(app, booking.bookingId);
    const payload = JSON.stringify({
      webhookEventId: generateIdempotencyKey(),
      paymentEventId: intent.paymentEventId,
      eventType: 'payment.succeeded',
      amount: intent.amount,
      currency: 'USD',
    });
    const res = await request(app)
      .post('/webhooks/payment')
      .set('Content-Type', 'application/json')
      .set('x-webhook-signature', 'badsignature')
      .send(Buffer.from(payload));
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('INVALID_SIGNATURE');
  });

  it('returns 401 when signature uses wrong secret', async () => {
    const booking = await createBooking(app);
    const intent = await createPaymentIntent(app, booking.bookingId);
    const result = await sendWebhook(app, {
      webhookEventId: generateIdempotencyKey(),
      paymentEventId: intent.paymentEventId,
      amount: intent.amount,
    }, 'wrong-secret');
    expect(result.status).toBe(401);
  });
});

// ── AT-13: Input validation ───────────────────────────────────

describe('AT-13: Input validation', () => {
  it('POST /bookings returns 400 when required fields missing', async () => {
    const res = await request(app).post('/bookings').send({ name: 'Jane' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('MISSING_FIELDS');
  });

  it('POST /payments/intent returns 400 when bookingId missing', async () => {
    const res = await request(app).post('/payments/intent').send({ paymentType: 'FULL' });
    expect(res.status).toBe(400);
  });

  it('POST /payments/intent returns 404 for unknown bookingId', async () => {
    const res = await request(app).post('/payments/intent').send({
      bookingId: generateIdempotencyKey(),
      paymentType: 'FULL',
    });
    expect(res.status).toBe(404);
  });
});

// ── AT-14: Deposit flow ──────────────────────────────────────

describe('AT-14: Deposit payment flow', () => {
  it('deposit booking creates job with PAID_DEPOSIT status', async () => {
    const booking = await createBooking(app, { paymentMode: 'DEPOSIT' });
    const intent = await createPaymentIntent(app, booking.bookingId, 'DEPOSIT');
    const result = await sendWebhook(app, {
      webhookEventId: generateIdempotencyKey(),
      paymentEventId: intent.paymentEventId,
      amount: intent.amount,
    });
    expect(result.body.outcome).toBe('SUCCESS');
    const jobRes = await request(app).get(`/jobs/${result.body.jobId}`);
    expect(jobRes.body.status).toBe('PAID_DEPOSIT');
  });
});

// ── AT-15: Full payment flow ─────────────────────────────────

describe('AT-15: Full payment flow', () => {
  it('full payment creates job with PAID_FULL status', async () => {
    const flow = await runFullPaymentFlow(app);
    const jobRes = await request(app).get(`/jobs/${flow.jobId}`);
    expect(jobRes.body.status).toBe('PAID_FULL');
  });
});

// ── AT-16: Dispatch engine ───────────────────────────────────

describe('AT-16: Dispatch engine', () => {
  it('POST /jobs/:id/dispatch creates a dispatch attempt', async () => {
    const flow = await runFullPaymentFlow(app);
    const res = await request(app)
      .post(`/jobs/${flow.jobId}/dispatch`)
      .send({ contractorId: 'contractor-001' });
    expect(res.status).toBe(201);
    expect(res.body.attemptId).toBeDefined();
    expect(res.body.attemptNumber).toBe(1);
    expect(res.body.contractorId).toBe('contractor-001');
  });

  it('job transitions to DISPATCHING after dispatch offer', async () => {
    const flow = await runFullPaymentFlow(app);
    await request(app).post(`/jobs/${flow.jobId}/dispatch`).send({ contractorId: 'c-001' });
    const jobRes = await request(app).get(`/jobs/${flow.jobId}`);
    expect(jobRes.body.status).toBe('DISPATCHING');
  });
});

// ── AT-17: Contractor acceptance ─────────────────────────────

describe('AT-17: Contractor acceptance', () => {
  it('ACCEPTED response transitions job to ASSIGNED', async () => {
    const flow = await runFullPaymentFlow(app);
    const dispatchRes = await request(app)
      .post(`/jobs/${flow.jobId}/dispatch`)
      .send({ contractorId: 'c-001' });
    const respondRes = await request(app)
      .post(`/dispatch/${dispatchRes.body.attemptId}/respond`)
      .send({ response: 'ACCEPTED' });
    expect(respondRes.body.outcome).toBe('ACCEPTED_WINNER');
    expect(respondRes.body.jobCode).toBe(flow.jobCode);
    const jobRes = await request(app).get(`/jobs/${flow.jobId}`);
    expect(jobRes.body.status).toBe('ASSIGNED');
    expect(jobRes.body.assignedContractorId).toBe('c-001');
  });

  it('DECLINED response records DECLINED in history', async () => {
    const flow = await runFullPaymentFlow(app);
    const dispatchRes = await request(app)
      .post(`/jobs/${flow.jobId}/dispatch`)
      .send({ contractorId: 'c-001' });
    const respondRes = await request(app)
      .post(`/dispatch/${dispatchRes.body.attemptId}/respond`)
      .send({ response: 'DECLINED' });
    expect(respondRes.body.outcome).toBe('DECLINED');
  });
});

// ── AT-18: Atomic dispatch — first contractor wins ────────────

describe('AT-18: Atomic dispatch assignment', () => {
  it('second ACCEPTED for same job returns ALREADY_ASSIGNED', async () => {
    const flow = await runFullPaymentFlow(app);
    const d1 = await request(app).post(`/jobs/${flow.jobId}/dispatch`).send({ contractorId: 'c-001' });
    const d2 = await request(app).post(`/jobs/${flow.jobId}/dispatch`).send({ contractorId: 'c-002' });
    const r1 = await request(app).post(`/dispatch/${d1.body.attemptId}/respond`).send({ response: 'ACCEPTED' });
    const r2 = await request(app).post(`/dispatch/${d2.body.attemptId}/respond`).send({ response: 'ACCEPTED' });
    expect(r1.body.outcome).toBe('ACCEPTED_WINNER');
    expect(r2.body.outcome).toBe('ALREADY_ASSIGNED');
    const jobRes = await request(app).get(`/jobs/${flow.jobId}`);
    expect(jobRes.body.assignedContractorId).toBe('c-001');
  });
});

// ── AT-19: Dispatch history ───────────────────────────────────

describe('AT-19: Dispatch history', () => {
  it('GET /jobs/:id includes dispatch history with attempt numbers', async () => {
    const flow = await runFullPaymentFlow(app);
    await request(app).post(`/jobs/${flow.jobId}/dispatch`).send({ contractorId: 'c-001' });
    await request(app).post(`/jobs/${flow.jobId}/dispatch`).send({ contractorId: 'c-002' });
    const res = await request(app).get(`/jobs/${flow.jobId}`);
    expect(res.body.dispatchHistory).toHaveLength(2);
    expect(res.body.dispatchHistory[0].attemptNumber).toBe(1);
    expect(res.body.dispatchHistory[1].attemptNumber).toBe(2);
  });
});

// ── AT-20: Price version locked at booking time ───────────────

describe('AT-20: Price version locked at booking creation', () => {
  it('booking records the price version at creation time', async () => {
    const res = await request(app).post('/bookings').send(makeBookingPayload());
    expect(res.body.pricing.priceVersion).toBe(5)  // v5;
  });

  it('job inherits price version from booking', async () => {
    const flow = await runFullPaymentFlow(app);
    const jobRes = await request(app).get(`/jobs/${flow.jobId}`);
    expect(jobRes.body.priceVersion).toBe(5)  // v5;
  });
});

// ── AT-21: Webhook replay ─────────────────────────────────────

describe('AT-21: Webhook replay', () => {
  it('replaying a processed webhook returns DUPLICATE (safe)', async () => {
    const flow = await runFullPaymentFlow(app);
    const res = await request(app)
      .post('/webhooks/payment/replay')
      .send({ webhookEventId: flow.webhookEventId });
    expect(res.status).toBe(200);
    expect(res.body.replayed).toBe(true);
    expect(res.body.outcome).toBe('DUPLICATE');
  });

  it('replay of unknown webhookEventId returns 404', async () => {
    const res = await request(app)
      .post('/webhooks/payment/replay')
      .send({ webhookEventId: generateIdempotencyKey() });
    expect(res.status).toBe(404);
  });
});

// ── AT-22: Exactly one job per booking ───────────────────────

describe('AT-22: Exactly one job per booking', () => {
  it('two webhooks for same paymentEventId create exactly one job', async () => {
    const booking = await createBooking(app);
    const intent = await createPaymentIntent(app, booking.bookingId);
    const r1 = await sendWebhook(app, {
      webhookEventId: generateIdempotencyKey(),
      paymentEventId: intent.paymentEventId,
      amount: intent.amount,
    });
    const r2 = await sendWebhook(app, {
      webhookEventId: generateIdempotencyKey(),
      paymentEventId: intent.paymentEventId,
      amount: intent.amount,
    });
    expect(r1.body.outcome).toBe('SUCCESS');
    expect(r2.body.outcome).toBe('DUPLICATE');
    expect(r1.body.jobId).toBe(r2.body.jobId);
  });
});

// ── AT-23: PAYMENT_NOT_FOUND for unknown paymentEventId ───────

describe('AT-23: Webhook with unknown paymentEventId', () => {
  it('returns PAYMENT_NOT_FOUND for unknown paymentEventId', async () => {
    const result = await sendWebhook(app, {
      webhookEventId: generateIdempotencyKey(),
      paymentEventId: generateIdempotencyKey(),
      amount: 12900,
    });
    expect(result.body.outcome).toBe('PAYMENT_NOT_FOUND');
  });
});

// ── AT-24: OUTSIDE_AREA booking cannot get payment intent ─────

describe('AT-24: Outside-area booking cannot get payment intent', () => {
  it('payment intent blocked for outside-area booking', async () => {
    const booking = await createBooking(app, { areaStatus: 'OUTSIDE_AREA' });
    const res = await request(app)
      .post('/payments/intent')
      .send({ bookingId: booking.bookingId, paymentType: 'FULL' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('OUTSIDE_AREA');
  });
});

// ── AT-25: Dispatch attempt counter ──────────────────────────

describe('AT-25: Dispatch attempt counter', () => {
  it('dispatch_attempts increments with each offer', async () => {
    const flow = await runFullPaymentFlow(app);
    await request(app).post(`/jobs/${flow.jobId}/dispatch`).send({ contractorId: 'c-001' });
    const r1 = await request(app).get(`/jobs/${flow.jobId}`);
    expect(r1.body.dispatchAttempts).toBe(1);
    await request(app).post(`/jobs/${flow.jobId}/dispatch`).send({ contractorId: 'c-002' });
    const r2 = await request(app).get(`/jobs/${flow.jobId}`);
    expect(r2.body.dispatchAttempts).toBe(2);
  });
});

// ── AT-26: Invalid dispatch response rejected ─────────────────

describe('AT-26: Invalid dispatch response rejected', () => {
  it('returns 400 for invalid response value', async () => {
    const flow = await runFullPaymentFlow(app);
    const d = await request(app).post(`/jobs/${flow.jobId}/dispatch`).send({ contractorId: 'c-001' });
    const res = await request(app)
      .post(`/dispatch/${d.body.attemptId}/respond`)
      .send({ response: 'MAYBE' });
    expect(res.status).toBe(400);
  });

  it('returns 404 for unknown attemptId', async () => {
    const res = await request(app)
      .post(`/dispatch/${generateIdempotencyKey()}/respond`)
      .send({ response: 'ACCEPTED' });
    expect(res.status).toBe(404);
  });
});

// ── AT-27: Booking not found ──────────────────────────────────

describe('AT-27: Booking not found', () => {
  it('GET /bookings/:id returns 404 for unknown bookingId', async () => {
    const res = await request(app).get(`/bookings/${generateIdempotencyKey()}`);
    expect(res.status).toBe(404);
  });
});

// ── AT-28: Job not found ──────────────────────────────────────

describe('AT-28: Job not found', () => {
  it('GET /jobs/:id returns 404 for unknown jobId', async () => {
    const res = await request(app).get(`/jobs/${generateIdempotencyKey()}`);
    expect(res.status).toBe(404);
  });
});
