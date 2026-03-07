// ============================================================
// Assembly Concierge MVP v2 — Unit Tests: Domain Layer
// ============================================================

import { describe, it, expect } from '@jest/globals';
import {
  computePrice, verifyPaymentAmount, calculateRemainder, CURRENT_PRICE_VERSION,
} from '../../src/domain/pricing.js';
import {
  transitionBooking, transitionJob, isBookingTerminal, isJobTerminal,
} from '../../src/domain/stateMachine.js';
import {
  generateId, generatePublicJobCode, isValidJobCode, isValidUuidV4, generateIdempotencyKey,
} from '../../src/domain/identifiers.js';
import { StateTransitionError, CustomJobError } from '../../src/domain/types.js';
import { verifySignature, signPayload } from '../../src/lib/webhookSecurity.js';

// ── Pricing Engine ───────────────────────────────────────────

describe('Pricing Engine', () => {
  it('computes SMALL base price correctly', () => {
    const r = computePrice('SMALL', false);
    expect(r.basePrice).toBe(7900);
    expect(r.rushFee).toBe(0);
    expect(r.quotedTotal).toBe(7900);
    expect(r.priceVersion).toBe(CURRENT_PRICE_VERSION);
  });

  it('computes MEDIUM base price correctly', () => {
    const r = computePrice('MEDIUM', false);
    expect(r.basePrice).toBe(12900);
    expect(r.quotedTotal).toBe(12900);
  });

  it('computes LARGE base price correctly', () => {
    const r = computePrice('LARGE', false);
    expect(r.basePrice).toBe(19900);
    expect(r.quotedTotal).toBe(19900);
  });

  it('computes TREADMILL base price correctly', () => {
    const r = computePrice('TREADMILL', false);
    expect(r.basePrice).toBe(14900);
    expect(r.quotedTotal).toBe(14900);
  });

  it('adds SAME_DAY rush fee of $30 when rush=true (v5 rule)', () => {
    const r = computePrice('MEDIUM', true);
    expect(r.rushFee).toBe(3000);  // v5: SAME_DAY=$30 (not $50)
    expect(r.quotedTotal).toBe(15900);
  });

  it('computes deposit as floor(quotedTotal / 2)', () => {
    const r = computePrice('MEDIUM', false);
    expect(r.depositAmount).toBe(Math.floor(12900 / 2));
    expect(r.depositAmount).toBe(6450);
  });

  it('deposit + remainder equals total for all service types', () => {
    const services = ['SMALL', 'MEDIUM', 'LARGE', 'TREADMILL'] as const;
    for (const svc of services) {
      for (const rush of [false, true]) {
        const r = computePrice(svc, rush);
        const remainder = calculateRemainder(r.quotedTotal, r.depositAmount);
        expect(r.depositAmount + remainder).toBe(r.quotedTotal);
      }
    }
  });

  it('CUSTOM service type returns $0 base price without throwing (v5)', () => {
    const r = computePrice('CUSTOM', false);
    expect(r.basePrice).toBe(0);
    expect(r.quotedTotal).toBe(0);
  });

  it('verifyPaymentAmount returns ok=true for exact match', () => {
    expect(verifyPaymentAmount(12900, 12900).ok).toBe(true);
  });

  it('verifyPaymentAmount returns ok=false for mismatch', () => {
    const r = verifyPaymentAmount(12900, 12800);
    expect(r.ok).toBe(false);
    expect(r.expected).toBe(12900);
    expect(r.received).toBe(12800);
  });

  it('calculateRemainder returns correct value', () => {
    expect(calculateRemainder(12900, 6450)).toBe(6450);
    expect(calculateRemainder(19900, 9950)).toBe(9950);
  });
});

// ── BookingRequest State Machine ─────────────────────────────

describe('BookingRequest State Machine', () => {
  it('RECEIVED → PRICED is valid', () => {
    expect(transitionBooking('RECEIVED', 'PRICED')).toBe('PRICED');
  });

  it('RECEIVED → AWAITING_QUOTE is valid (CUSTOM service)', () => {
    expect(transitionBooking('RECEIVED', 'AWAITING_QUOTE')).toBe('AWAITING_QUOTE');
  });

  it('PRICED → AWAITING_PAYMENT is valid', () => {
    expect(transitionBooking('PRICED', 'AWAITING_PAYMENT')).toBe('AWAITING_PAYMENT');
  });

  it('AWAITING_PAYMENT → CONVERTED is valid', () => {
    expect(transitionBooking('AWAITING_PAYMENT', 'CONVERTED')).toBe('CONVERTED');
  });

  it('AWAITING_PAYMENT → PAYMENT_FAILED is valid', () => {
    expect(transitionBooking('AWAITING_PAYMENT', 'PAYMENT_FAILED')).toBe('PAYMENT_FAILED');
  });

  it('CONVERTED is a terminal state', () => {
    expect(isBookingTerminal('CONVERTED')).toBe(true);
    expect(() => transitionBooking('CONVERTED', 'PRICED')).toThrow(StateTransitionError);
  });

  it('EXPIRED is a terminal state', () => {
    expect(isBookingTerminal('EXPIRED')).toBe(true);
  });

  it('CANCELLED is a terminal state', () => {
    expect(isBookingTerminal('CANCELLED')).toBe(true);
  });

  it('invalid transition throws StateTransitionError with from/to', () => {
    try {
      transitionBooking('RECEIVED', 'CONVERTED');
      expect(true).toBe(false); // should not reach here
    } catch (e) {
      expect(e).toBeInstanceOf(StateTransitionError);
      expect((e as StateTransitionError).from).toBe('RECEIVED');
      expect((e as StateTransitionError).to).toBe('CONVERTED');
    }
  });
});

// ── Job State Machine ────────────────────────────────────────

describe('Job State Machine', () => {
  it('PAID_FULL → DISPATCHING is valid', () => {
    expect(transitionJob('PAID_FULL', 'DISPATCHING')).toBe('DISPATCHING');
  });

  it('PAID_DEPOSIT → DISPATCHING is valid', () => {
    expect(transitionJob('PAID_DEPOSIT', 'DISPATCHING')).toBe('DISPATCHING');
  });

  it('DISPATCHING → ASSIGNED is valid', () => {
    expect(transitionJob('DISPATCHING', 'ASSIGNED')).toBe('ASSIGNED');
  });

  it('DISPATCHING → DISPATCH_FAILED is valid', () => {
    expect(transitionJob('DISPATCHING', 'DISPATCH_FAILED')).toBe('DISPATCH_FAILED');
  });

  it('ASSIGNED → IN_PROGRESS is valid', () => {
    expect(transitionJob('ASSIGNED', 'IN_PROGRESS')).toBe('IN_PROGRESS');
  });

  it('IN_PROGRESS → COMPLETED is valid', () => {
    expect(transitionJob('IN_PROGRESS', 'COMPLETED')).toBe('COMPLETED');
  });

  it('COMPLETED → REMAINDER_DUE is valid (deposit path)', () => {
    expect(transitionJob('COMPLETED', 'REMAINDER_DUE')).toBe('REMAINDER_DUE');
  });

  it('DISPATCH_FAILED → DISPATCHING is valid (retry)', () => {
    expect(transitionJob('DISPATCH_FAILED', 'DISPATCHING')).toBe('DISPATCHING');
  });

  it('DISPATCH_FAILED → NEEDS_MANUAL_REVIEW is valid', () => {
    expect(transitionJob('DISPATCH_FAILED', 'NEEDS_MANUAL_REVIEW')).toBe('NEEDS_MANUAL_REVIEW');
  });

  it('CANCELLED is a terminal state', () => {
    expect(isJobTerminal('CANCELLED')).toBe(true);
    expect(() => transitionJob('CANCELLED', 'DISPATCHING')).toThrow(StateTransitionError);
  });

  it('PAID_FULL → ASSIGNED throws (must go through DISPATCHING)', () => {
    expect(() => transitionJob('PAID_FULL', 'ASSIGNED')).toThrow(StateTransitionError);
  });

  it('PAID_FULL → COMPLETED throws', () => {
    expect(() => transitionJob('PAID_FULL', 'COMPLETED')).toThrow(StateTransitionError);
  });
});

// ── Identifier Generation ────────────────────────────────────

describe('Identifier Generation', () => {
  it('generateId returns a UUID v7 format string', () => {
    const id = generateId();
    expect(typeof id).toBe('string');
    expect(id).toHaveLength(36);
    expect(id.split('-')).toHaveLength(5);
  });

  it('generateId produces 1000 unique values', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => generateId()));
    expect(ids.size).toBe(1000);
  });

  it('generatePublicJobCode returns AC-XXXX-XXXX format', () => {
    const code = generatePublicJobCode();
    expect(isValidJobCode(code)).toBe(true);
    expect(code.startsWith('AC-')).toBe(true);
    expect(code).toHaveLength(12);
  });

  it('generatePublicJobCode uses unambiguous alphabet (no I, O, 1, 0)', () => {
    for (let i = 0; i < 200; i++) {
      const code = generatePublicJobCode();
      const chars = code.replace('AC-', '').replace('-', '');
      expect(chars).not.toMatch(/[IO10]/);
    }
  });

  it('isValidJobCode validates correct format', () => {
    expect(isValidJobCode('AC-ABCD-EFGH')).toBe(true);
    expect(isValidJobCode('AC-2345-6789')).toBe(true);
  });

  it('isValidJobCode rejects invalid formats', () => {
    expect(isValidJobCode('AC-ABC-DEFG')).toBe(false);
    expect(isValidJobCode('ac-ABCD-EFGH')).toBe(false);
    expect(isValidJobCode('ABCD-EFGH')).toBe(false);
    expect(isValidJobCode('')).toBe(false);
  });

  it('generateIdempotencyKey returns a valid UUID v4', () => {
    const key = generateIdempotencyKey();
    expect(isValidUuidV4(key)).toBe(true);
  });

  it('isValidUuidV4 rejects non-v4 UUIDs', () => {
    expect(isValidUuidV4('not-a-uuid')).toBe(false);
    expect(isValidUuidV4('')).toBe(false);
  });
});

// ── Webhook Security ─────────────────────────────────────────

describe('Webhook Security', () => {
  const secret = 'my-test-secret';
  const body = '{"event":"payment.succeeded","amount":12900}';

  it('verifies a valid HMAC-SHA256 signature', () => {
    const sig = signPayload(secret, body);
    expect(verifySignature(body, sig, secret)).toBe(true);
  });

  it('verifies a valid signature from a Buffer body', () => {
    const buf = Buffer.from(body, 'utf8');
    const sig = signPayload(secret, buf);
    expect(verifySignature(buf, sig, secret)).toBe(true);
  });

  it('rejects an invalid signature', () => {
    expect(verifySignature(body, 'invalidsig', secret)).toBe(false);
  });

  it('rejects a signature computed with a different secret', () => {
    const sig = signPayload('wrong-secret', body);
    expect(verifySignature(body, sig, 'correct-secret')).toBe(false);
  });

  it('rejects if body is tampered after signing', () => {
    const sig = signPayload(secret, '{"amount":12900}');
    expect(verifySignature('{"amount":100}', sig, secret)).toBe(false);
  });

  it('rejects empty signature', () => {
    expect(verifySignature(body, '', secret)).toBe(false);
  });
});
