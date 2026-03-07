// ============================================================
// Assembly Concierge MVP v2 — Domain Types
//
// All monetary values are integer cents (USD).
// No floating-point arithmetic in the money path.
// Supersedes v1 types — complete state models per v2 spec.
// ============================================================

export type ServiceType = 'SMALL' | 'MEDIUM' | 'LARGE' | 'TREADMILL' | 'CUSTOM';

export type AreaStatus = 'IN_AREA' | 'OUTSIDE_AREA';

export type PaymentMode = 'FULL' | 'DEPOSIT';

export type PaymentType = 'FULL' | 'DEPOSIT' | 'REMAINDER';

export type PaymentStatus = 'PENDING' | 'SUCCEEDED' | 'FAILED' | 'REFUNDED';

// ── BookingRequest States ────────────────────────────────────
// A BookingRequest is a transient intake record. It exists from
// form submission until payment confirmation. It is never used
// for dispatch or assignment.

export type BookingRequestStatus =
  | 'RECEIVED'
  | 'PRICED'
  | 'AWAITING_QUOTE'       // CUSTOM service type — operator must set price
  | 'AWAITING_PAYMENT'
  | 'CONVERTED'
  | 'PAYMENT_FAILED'
  | 'EXPIRED'
  | 'CANCELLED';

// ── Job States ───────────────────────────────────────────────
// A Job is a permanent operational record created exactly once
// after payment.succeeded webhook is processed and price verified.

export type JobStatus =
  | 'PAYMENT_PENDING'      // Job created; payment not yet confirmed (transient)
  | 'PAID_FULL'            // Full payment confirmed; ready for dispatch
  | 'PAID_DEPOSIT'         // Deposit confirmed; remainder due after completion
  | 'DISPATCHING'          // Dispatch sequence in progress
  | 'ASSIGNED'             // Contractor accepted; job scheduled
  | 'IN_PROGRESS'          // Contractor checked in on-site
  | 'COMPLETED'            // Work completed
  | 'REMAINDER_DUE'        // Completed; customer owes remainder
  | 'REMAINDER_FAILED'     // Remainder payment attempt failed
  | 'DISPATCH_FAILED'      // All 5 dispatch attempts exhausted
  | 'NEEDS_MANUAL_REVIEW'  // Operator intervention required
  | 'CANCELLED';

export type DispatchResponse = 'ACCEPTED' | 'DECLINED' | 'TIMEOUT';

// ── Entities ─────────────────────────────────────────────────

export interface Customer {
  customerId: string;
  name: string;
  email: string;
  phone: string;
  emailLower: string;
  createdAt: string;
  updatedAt: string;
}

export interface BookingRequest {
  bookingId: string;
  customerId: string;
  idempotencyKey: string;
  serviceType: ServiceType;
  rush: boolean;
  rawAddress: string;
  resolvedCity: string | null;
  resolvedZip: string | null;
  areaStatus: AreaStatus;
  priceVersion: number;
  basePrice: number;           // cents
  rushFee: number;             // cents
  quotedTotal: number;         // cents; always server-computed
  depositAmount: number | null; // cents; null if paymentMode=FULL
  paymentMode: PaymentMode;
  status: BookingRequestStatus;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface Job {
  jobId: string;
  jobCode: string;             // AC-XXXX-XXXX; cross-system identifier; immutable
  bookingId: string;
  customerId: string;
  serviceType: ServiceType;
  rush: boolean;
  resolvedCity: string;
  rawAddress: string;
  priceVersion: number;
  quotedTotal: number;         // cents; locked at booking creation
  depositAmount: number | null;
  paymentMode: PaymentMode;
  status: JobStatus;
  assignedContractorId: string | null;
  scheduledAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  dispatchAttempts: number;
  createdAt: string;
  updatedAt: string;
}

export interface Payment {
  paymentId: string;
  jobId: string | null;        // null until job created after webhook
  bookingId: string;
  customerId: string;
  paymentType: PaymentType;
  amount: number;              // cents; server-computed, never client-supplied
  currency: string;
  status: PaymentStatus;
  paymentEventId: string;      // processor-assigned; reconciliation key
  processorRef: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DispatchAttempt {
  attemptId: string;
  jobId: string;
  contractorId: string;
  attemptNumber: number;
  offeredAt: string;
  expiresAt: string;
  response: DispatchResponse | null;
  respondedAt: string | null;
  createdAt: string;
}

export interface WebhookEvent {
  webhookEventId: string;
  eventType: string;
  rawBody: string;
  signature: string;
  processedAt: string | null;
  outcome: string | null;
  createdAt: string;
}

// ── Pricing ──────────────────────────────────────────────────

export interface PricingResult {
  basePrice: number;     // cents
  rushFee: number;       // cents
  quotedTotal: number;   // cents
  depositAmount: number; // cents; floor(quotedTotal / 2)
  priceVersion: number;
}

// ── Error Classes ────────────────────────────────────────────

export class StateTransitionError extends Error {
  constructor(
    public readonly from: string,
    public readonly to: string,
    entity: string = 'entity',
  ) {
    super(`Invalid ${entity} state transition: ${from} → ${to}`);
    this.name = 'StateTransitionError';
  }
}

export class CustomJobError extends Error {
  constructor() {
    super('CUSTOM service type requires operator quote before pricing');
    this.name = 'CustomJobError';
  }
}

export class BookingExpiredError extends Error {
  constructor(bookingId: string) {
    super(`Booking ${bookingId} has expired`);
    this.name = 'BookingExpiredError';
  }
}

export class OutsideAreaError extends Error {
  constructor() {
    super('Payment not allowed for outside-area bookings');
    this.name = 'OutsideAreaError';
  }
}

export class PriceMismatchError extends Error {
  constructor(
    public readonly expected: number,
    public readonly received: number,
  ) {
    super(`Price mismatch: expected ${expected} cents, received ${received} cents`);
    this.name = 'PriceMismatchError';
  }
}

export class AlreadyAssignedError extends Error {
  constructor(jobCode: string) {
    super(`Job ${jobCode} is already assigned to another contractor`);
    this.name = 'AlreadyAssignedError';
  }
}
