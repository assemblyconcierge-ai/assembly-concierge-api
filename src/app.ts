// ============================================================
// Assembly Concierge MVP v3 — Express Application
//
// Routes:
//   GET  /health
//   POST /intake
//   POST /bookings
//   GET  /bookings/:id
//   POST /payments/intent
//   POST /webhooks/payment
//   POST /webhooks/payment/replay
//   POST /jobs/:id/dispatch
//   POST /dispatch/:attemptId/respond
//   GET  /jobs/:id
//   GET  /jobs/code/:jobCode
// ============================================================

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import type { Database } from 'sql.js';

import { normalizeJotformPayload } from './domain/jotformNormalizer.js';
import { calculatePricing } from './domain/pricing.js';
import { verifyInboundWebhook } from './lib/webhookSecurity.js';
import { generateIdempotencyKey } from './domain/identifiers.js';
import type { ServiceType, PaymentMode, AreaStatus } from './domain/types.js';

import { createBooking, getBookingById } from './db/bookingRepository.js';
import {
  createPaymentIntent,
  processWebhook,
  replayWebhook,
  getJobByBookingId,
  getJobById,
  getJobByCode,
  offerDispatch,
  respondDispatch,
  getDispatchAttempts,
} from './db/paymentRepository.js';
import { now } from './db/database.js';

export function createApp(db: Database) {
  const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET ?? 'test-secret-key';
  const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET ?? '';

  const app = express();
  app.use(cors());

  // JSON parser for all routes except POST /webhooks/payment
  app.use((req, res, next) => {
    if (req.method === 'POST' && req.path === '/webhooks/payment') return next();
    express.json()(req, res, next);
  });

  // ── POST /intake ─────────────────────────────────────────
  app.post('/intake', async (req, res) => {
    try {
      const raw = req.body;
      if (!raw || typeof raw !== 'object') {
        return res.status(400).json({ error: 'MISSING_BODY' });
      }

      const intake = normalizeJotformPayload(raw);

      if (!intake.submission_id) {
        return res.status(400).json({ error: 'MISSING_SUBMISSION_ID' });
      }
      if (!intake.customer_name || !intake.customer_email) {
        return res.status(400).json({ error: 'MISSING_FIELDS', detail: 'name and email required' });
      }

      const pricing = calculatePricing(
        intake.service_type,
        intake.rush_type,
        intake.payment_mode,
      );

      const result = await createBooking(db, {
        idempotencyKey: intake.idempotency_key,
        name: intake.customer_name,
        email: intake.customer_email,
        phone: intake.customer_phone_e164 ?? intake.customer_phone_raw,
        serviceType: intake.service_type,
        rush: intake.rush_type !== 'NO_RUSH',
        rawAddress: intake.customer_address,
        resolvedCity: intake.service_city,
        resolvedZip: intake.zip_code,
        areaStatus: intake.area_status,
        paymentMode: intake.payment_mode,
      });

      const b = result.booking;

      return res.status(result.created ? 201 : 200).json({
        job_code: null,
        booking_id: b.bookingId,
        customer_id: b.customerId,
        submission_id: intake.submission_id,
        idempotency_key: intake.idempotency_key,
        area_status: intake.area_status,
        service_type: intake.service_type,
        rush_type: intake.rush_type,
        payment_mode: intake.payment_mode,
        authorized_total: pricing.display.authorized_total,
        deposit_amount: pricing.display.deposit_amount,
        remaining_balance: pricing.display.remaining_balance,
        authorized_total_cents: pricing.authorized_total_cents,
        deposit_amount_cents: pricing.deposit_amount_cents,
        remaining_balance_cents: pricing.remaining_balance_cents,
        price_version: pricing.price_version,
        customer: {
          name: intake.customer_name,
          email: intake.customer_email,
          phone_raw: intake.customer_phone_raw,
          phone_e164: intake.customer_phone_e164,
          address: intake.customer_address,
          service_city: intake.service_city,
          state: intake.state,
          zip_code: intake.zip_code,
        },
        appointment: {
          date: intake.appointment_date,
          window: intake.appointment_window,
        },
        photos: intake.photos,
        customer_notes: intake.customer_notes,
        next_action:
          intake.area_status === 'IN_AREA'
            ? intake.service_type === 'CUSTOM'
              ? 'AWAIT_QUOTE'
              : 'PROCEED_TO_PAYMENT'
            : 'MANUAL_REVIEW',
        created: result.created,
      });
    } catch (err: any) {
      console.error('POST /intake error:', err);
      return res.status(500).json({ error: 'INTERNAL_ERROR', message: err?.message ?? String(err) });
    }
  });

  // ── GET /health ──────────────────────────────────────────
  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      timestamp: now(),
      version: '1.0.0',
      environment: process.env.NODE_ENV ?? 'development',
    });
  });

  // ── POST /bookings ───────────────────────────────────────
  app.post('/bookings', async (req, res) => {
    try {
      const {
        idempotencyKey,
        name,
        email,
        phone,
        serviceType,
        rush,
        rawAddress,
        resolvedCity,
        resolvedZip,
        areaStatus,
        paymentMode,
      } = req.body;

      if (!idempotencyKey || !name || !email || !phone || !serviceType || !rawAddress) {
        return res.status(400).json({ error: 'MISSING_FIELDS' });
      }

      const result = await createBooking(db, {
        idempotencyKey,
        name,
        email,
        phone,
        serviceType: serviceType as ServiceType,
        rush: Boolean(rush),
        rawAddress,
        resolvedCity: resolvedCity ?? null,
        resolvedZip: resolvedZip ?? null,
        areaStatus: (areaStatus ?? 'IN_AREA') as AreaStatus,
        paymentMode: (paymentMode ?? 'FULL') as PaymentMode,
      });

      const b = result.booking;

      return res.status(result.created ? 201 : 200).json({
        bookingId: b.bookingId,
        customerId: b.customerId,
        jobCode: null,
        status: b.status,
        areaStatus: b.areaStatus,
        serviceType: b.serviceType,
        rush: b.rush,
        pricing: {
          basePrice: b.basePrice,
          rushFee: b.rushFee,
          quotedTotal: b.quotedTotal,
          depositAmount: b.depositAmount,
          priceVersion: b.priceVersion,
          display: {
            basePrice: `$${(b.basePrice / 100).toFixed(2)}`,
            rushFee: b.rush ? `$${(b.rushFee / 100).toFixed(2)}` : null,
            quotedTotal: `$${(b.quotedTotal / 100).toFixed(2)}`,
            depositAmount: `$${((b.depositAmount ?? 0) / 100).toFixed(2)}`,
            remainderAmount: `$${((b.quotedTotal - (b.depositAmount ?? 0)) / 100).toFixed(2)}`,
          },
        },
        paymentMode: b.paymentMode,
        expiresAt: b.expiresAt,
        created: result.created,
        idempotencyKey,
      });
    } catch (err: any) {
      console.error('POST /bookings error:', err);
      return res.status(500).json({ error: 'INTERNAL_ERROR', message: err?.message ?? String(err) });
    }
  });

  // ── GET /bookings/:id ────────────────────────────────────
  app.get('/bookings/:id', async (req, res) => {
    try {
      const booking = await getBookingById(db, req.params.id);
      if (!booking) return res.status(404).json({ error: 'NOT_FOUND' });

      const job = await getJobByBookingId(db, req.params.id);

      return res.json({
        ...booking,
        job: job
          ? {
              jobId: job.jobId,
              jobCode: job.jobCode,
              status: job.status,
              dispatchAttempts: job.dispatchAttempts,
              assignedContractorId: job.assignedContractorId,
            }
          : null,
      });
    } catch (err: any) {
      return res.status(500).json({ error: 'INTERNAL_ERROR', message: err?.message ?? String(err) });
    }
  });

  // ── POST /payments/intent ────────────────────────────────
  app.post('/payments/intent', async (req, res) => {
    try {
      const { bookingId, paymentType } = req.body;

      if (!bookingId || !paymentType) {
        return res.status(400).json({ error: 'MISSING_FIELDS' });
      }

      const booking = await getBookingById(db, bookingId);
      if (!booking) return res.status(404).json({ error: 'BOOKING_NOT_FOUND' });

      if (booking.areaStatus === 'OUTSIDE_AREA') {
        return res.status(400).json({ error: 'OUTSIDE_AREA' });
      }

      const amount =
        paymentType === 'DEPOSIT'
          ? (booking.depositAmount ?? booking.quotedTotal)
          : booking.quotedTotal;

      const paymentEventId = generateIdempotencyKey();

      const result = await createPaymentIntent(db, {
        bookingId,
        customerId: booking.customerId,
        paymentType: paymentType as 'FULL' | 'DEPOSIT',
        amount,
        paymentEventId,
      });

      return res.status(201).json(result);
    } catch (err: any) {
      console.error('POST /payments/intent error:', err);
      return res.status(500).json({ error: 'INTERNAL_ERROR', message: err?.message ?? String(err) });
    }
  });

  // ── POST /webhooks/payment ───────────────────────────────
  app.post('/webhooks/payment', express.raw({ type: 'application/json' }), async (req, res) => {
    try {
      const rawBody: Buffer = req.body;

      const { valid, mode } = verifyInboundWebhook(
        rawBody,
        req.headers as Record<string, string | string[] | undefined>,
        WEBHOOK_SECRET,
        STRIPE_WEBHOOK_SECRET || undefined,
      );

      if (!valid) {
        return res.status(401).json({ error: 'INVALID_SIGNATURE', mode });
      }

      const signature = (req.headers['stripe-signature'] ?? req.headers['x-webhook-signature'] ?? '') as string;

      let event: any;
      try {
        event = JSON.parse(rawBody.toString('utf8'));
      } catch {
        return res.status(400).json({ error: 'INVALID_JSON' });
      }

      const { webhookEventId, paymentEventId, eventType, amount, currency } = event;

      if (!webhookEventId || !paymentEventId || !eventType || amount === undefined) {
        return res.status(400).json({ error: 'MISSING_FIELDS' });
      }

      const result = await processWebhook(
        db,
        {
          webhookEventId,
          paymentEventId,
          eventType,
          amount,
          currency: currency ?? 'USD',
        },
        rawBody.toString('utf8'),
        signature,
      );

      return res.json(result);
    } catch (err: any) {
      console.error('POST /webhooks/payment error:', err);
      return res.status(500).json({ error: 'INTERNAL_ERROR', message: err?.message ?? String(err) });
    }
  });

  // ── POST /webhooks/payment/replay ────────────────────────
  app.post('/webhooks/payment/replay', async (req, res) => {
    try {
      const { webhookEventId } = req.body;
      if (!webhookEventId) return res.status(400).json({ error: 'MISSING_FIELDS' });

      const result = await replayWebhook(db, webhookEventId);

      if (!result.replayed && result.outcome === 'NOT_FOUND') {
        return res.status(404).json({ error: 'NOT_FOUND' });
      }

      return res.json(result);
    } catch (err: any) {
      return res.status(500).json({ error: 'INTERNAL_ERROR', message: err?.message ?? String(err) });
    }
  });

  // ── POST /jobs/:id/dispatch ──────────────────────────────
  app.post('/jobs/:id/dispatch', async (req, res) => {
    try {
      const { contractorId, timeoutMinutes } = req.body;
      if (!contractorId) return res.status(400).json({ error: 'MISSING_FIELDS' });

      const attempt = await offerDispatch(db, {
        jobId: req.params.id,
        contractorId,
        timeoutMinutes: timeoutMinutes ?? 15,
      });

      const job = await getJobById(db, req.params.id);
      const expiresAt = new Date(Date.now() + (timeoutMinutes ?? 15) * 60 * 1000).toISOString();

      return res.status(201).json({
        ...attempt,
        smsTemplate: job ? buildDispatchSms(job, attempt.attemptId, expiresAt) : null,
      });
    } catch (err: any) {
      return res.status(500).json({ error: 'INTERNAL_ERROR', message: err?.message ?? String(err) });
    }
  });

  // ── POST /dispatch/:attemptId/respond ────────────────────
  app.post('/dispatch/:attemptId/respond', async (req, res) => {
    try {
      const { response } = req.body;

      if (!response || !['ACCEPTED', 'DECLINED'].includes(response)) {
        return res.status(400).json({ error: 'INVALID_RESPONSE' });
      }

      const result = await respondDispatch(db, {
        attemptId: req.params.attemptId,
        response: response as 'ACCEPTED' | 'DECLINED',
      });

      if (result.outcome === 'NOT_FOUND') {
        return res.status(404).json({ error: 'NOT_FOUND' });
      }

      const outcomeMap: Record<string, string> = {
        ASSIGNED: 'ACCEPTED_WINNER',
        ALREADY_ASSIGNED: 'ALREADY_ASSIGNED',
        DECLINED: 'DECLINED',
        EXPIRED: 'EXPIRED',
      };

      const mappedOutcome = outcomeMap[result.outcome] ?? result.outcome;

      return res.json({ ...result, outcome: mappedOutcome });
    } catch (err: any) {
      return res.status(500).json({ error: 'INTERNAL_ERROR', message: err?.message ?? String(err) });
    }
  });

  // ── GET /jobs/code/:jobCode (before /jobs/:id) ───────────
  app.get('/jobs/code/:jobCode', async (req, res) => {
    try {
      const job = await getJobByCode(db, req.params.jobCode);
      if (!job) return res.status(404).json({ error: 'NOT_FOUND' });
      return res.json(job);
    } catch (err: any) {
      return res.status(500).json({ error: 'INTERNAL_ERROR', message: err?.message ?? String(err) });
    }
  });

  // ── GET /jobs/:id ────────────────────────────────────────
  app.get('/jobs/:id', async (req, res) => {
    try {
      const job = await getJobById(db, req.params.id);
      if (!job) return res.status(404).json({ error: 'NOT_FOUND' });

      const attempts = await getDispatchAttempts(db, req.params.id);

      return res.json({
        ...job,
        dispatchHistory: attempts,
      });
    } catch (err: any) {
      return res.status(500).json({ error: 'INTERNAL_ERROR', message: err?.message ?? String(err) });
    }
  });

  return app;
}

// ── Helpers ─────────────────────────────────────────────────

function buildDispatchSms(job: any, attemptId: string, expiresAt: string): string {
  const baseUrl = process.env.APP_BASE_URL ?? 'https://assemblyconcierge.com';
  const expireTime = new Date(expiresAt).toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
  });

  const serviceRaw = job.serviceType ?? job.service_type ?? '';
  const serviceLabel =
    serviceRaw.length > 0
      ? serviceRaw.charAt(0).toUpperCase() + serviceRaw.slice(1).toLowerCase()
      : 'Service';

  const rushLabel = job.rush === true || job.rush === 1 ? ' (RUSH)' : '';
  const total = job.quotedTotal ?? job.quoted_total ?? 0;
  const pay = `$${(total / 100).toFixed(2)}`;
  const jobCode = job.jobCode ?? job.job_code ?? '';
  const address = job.rawAddress ?? job.raw_address ?? '';

  return [
    `Assembly Concierge — New Job`,
    `Job: ${jobCode}`,
    `Service: ${serviceLabel}${rushLabel}`,
    `Address: ${address}`,
    `Pay: ${pay}`,
    `Reply ACCEPT ${jobCode} or DECLINE ${jobCode}`,
    `Or visit: ${baseUrl}/respond/${jobCode}/${attemptId}`,
    `Offer expires at ${expireTime}.`,
  ].join('\n');
}
