// ============================================================
// Assembly Concierge MVP v2 — State Machines
//
// Defines all valid state transitions for BookingRequest, Job,
// and Payment. Every external event must result in a deterministic
// transition. Throws StateTransitionError for invalid transitions.
// ============================================================

import type { BookingRequestStatus, JobStatus } from './types.js';
import { StateTransitionError } from './types.js';

// ── BookingRequest State Machine ─────────────────────────────

const BOOKING_TRANSITIONS: Record<BookingRequestStatus, BookingRequestStatus[]> = {
  RECEIVED:          ['PRICED', 'AWAITING_QUOTE', 'EXPIRED', 'CANCELLED'],
  PRICED:            ['AWAITING_PAYMENT', 'EXPIRED', 'CANCELLED'],
  AWAITING_QUOTE:    ['PRICED', 'CANCELLED'],
  AWAITING_PAYMENT:  ['CONVERTED', 'PAYMENT_FAILED', 'EXPIRED', 'CANCELLED'],
  CONVERTED:         [],
  PAYMENT_FAILED:    ['AWAITING_PAYMENT', 'EXPIRED', 'CANCELLED'],
  EXPIRED:           [],
  CANCELLED:         [],
};

export function transitionBooking(
  current: BookingRequestStatus,
  next: BookingRequestStatus,
): BookingRequestStatus {
  const allowed = BOOKING_TRANSITIONS[current] ?? [];
  if (!allowed.includes(next)) {
    throw new StateTransitionError(current, next, 'BookingRequest');
  }
  return next;
}

export function isBookingTerminal(status: BookingRequestStatus): boolean {
  return (BOOKING_TRANSITIONS[status] ?? []).length === 0;
}

// ── Job State Machine ────────────────────────────────────────

const JOB_TRANSITIONS: Record<JobStatus, JobStatus[]> = {
  PAYMENT_PENDING:     ['PAID_FULL', 'PAID_DEPOSIT', 'CANCELLED'],
  PAID_FULL:           ['DISPATCHING', 'CANCELLED'],
  PAID_DEPOSIT:        ['DISPATCHING', 'CANCELLED'],
  DISPATCHING:         ['ASSIGNED', 'DISPATCH_FAILED', 'CANCELLED'],
  ASSIGNED:            ['IN_PROGRESS', 'DISPATCHING', 'CANCELLED'],
  IN_PROGRESS:         ['COMPLETED', 'NEEDS_MANUAL_REVIEW'],
  COMPLETED:           ['REMAINDER_DUE', 'PAID_FULL'],
  REMAINDER_DUE:       ['PAID_FULL', 'REMAINDER_FAILED'],
  REMAINDER_FAILED:    ['REMAINDER_DUE'],
  DISPATCH_FAILED:     ['DISPATCHING', 'NEEDS_MANUAL_REVIEW', 'CANCELLED'],
  NEEDS_MANUAL_REVIEW: ['DISPATCHING', 'CANCELLED'],
  CANCELLED:           [],
};

export function transitionJob(
  current: JobStatus,
  next: JobStatus,
): JobStatus {
  const allowed = JOB_TRANSITIONS[current] ?? [];
  if (!allowed.includes(next)) {
    throw new StateTransitionError(current, next, 'Job');
  }
  return next;
}

export function isJobTerminal(status: JobStatus): boolean {
  return (JOB_TRANSITIONS[status] ?? []).length === 0;
}

// ── Payment State Machine ────────────────────────────────────

type PaymentStatus = 'PENDING' | 'SUCCEEDED' | 'FAILED' | 'REFUNDED';

const PAYMENT_TRANSITIONS: Record<PaymentStatus, PaymentStatus[]> = {
  PENDING:   ['SUCCEEDED', 'FAILED'],
  SUCCEEDED: ['REFUNDED'],
  FAILED:    [],
  REFUNDED:  [],
};

export function transitionPayment(
  current: PaymentStatus,
  next: PaymentStatus,
): PaymentStatus {
  const allowed = PAYMENT_TRANSITIONS[current] ?? [];
  if (!allowed.includes(next)) {
    throw new StateTransitionError(current, next, 'Payment');
  }
  return next;
}
