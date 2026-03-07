// ============================================================
// Assembly Concierge MVP v2 — Integration Tests: Webhook Replay
// ============================================================

import { describe, it, expect, beforeEach } from '@jest/globals';
import request from 'supertest';
import type { Express } from 'express';
import {
  buildApp, createBooking, createPaymentIntent, sendWebhook, runFullPaymentFlow,
} from '../fixtures/helpers.js';
import { generateIdempotencyKey } from '../../src/domain/identifiers.js';

let app: Express;

beforeEach(async () => {
  ({ app } = await buildApp());
});

describe('Webhook Replay Engine', () => {
  it('replaying a SUCCESS webhook returns DUPLICATE and same jobId', async () => {
    const flow = await runFullPaymentFlow(app);
    const res = await request(app)
      .post('/webhooks/payment/replay')
      .send({ webhookEventId: flow.webhookEventId });
    expect(res.status).toBe(200);
    expect(res.body.replayed).toBe(true);
    expect(res.body.outcome).toBe('DUPLICATE');
    expect(res.body.jobId).toBe(flow.jobId);
  });

  it('replay does not create a second job', async () => {
    const flow = await runFullPaymentFlow(app);
    await request(app).post('/webhooks/payment/replay').send({ webhookEventId: flow.webhookEventId });
    await request(app).post('/webhooks/payment/replay').send({ webhookEventId: flow.webhookEventId });
    const res = await request(app).get(`/bookings/${flow.bookingId}`);
    expect(res.body.job.jobId).toBe(flow.jobId);
  });

  it('replay of unknown webhookEventId returns 404', async () => {
    const res = await request(app)
      .post('/webhooks/payment/replay')
      .send({ webhookEventId: generateIdempotencyKey() });
    expect(res.status).toBe(404);
  });

  it('replay requires webhookEventId field', async () => {
    const res = await request(app).post('/webhooks/payment/replay').send({});
    expect(res.status).toBe(400);
  });

  it('replaying a PRICE_MISMATCH webhook returns DUPLICATE (not re-processed)', async () => {
    const booking = await createBooking(app);
    const intent = await createPaymentIntent(app, booking.bookingId);
    const webhookEventId = generateIdempotencyKey();

    const mismatch = await sendWebhook(app, {
      webhookEventId,
      paymentEventId: intent.paymentEventId,
      amount: intent.amount - 1,
    });
    expect(mismatch.body.outcome).toBe('PRICE_MISMATCH');

    const replay = await request(app)
      .post('/webhooks/payment/replay')
      .send({ webhookEventId });
    expect(replay.status).toBe(200);
    expect(replay.body.replayed).toBe(true);
    expect(replay.body.outcome).toBe('DUPLICATE');
  });
});
