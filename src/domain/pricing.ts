/**
 * Assembly Concierge — Pricing Engine v5
 *
 * RULES (server-enforced, all Jotform price fields ignored):
 *   Base prices: SMALL=7900, MEDIUM=12900, LARGE=19900, TREADMILL=14900, CUSTOM=0
 *   Rush fees:   SAME_DAY=3000, NEXT_DAY=2000, NO_RUSH=0
 *   Deposit:     floor(total / 2)   (50%, rounded down)
 *   Remaining:   total - deposit
 *   Price version locked at booking creation time.
 *
 * IGNORED Jotform fields: q44_calculation, q51_myProducts, q46_typeA46,
 *   q59_amountchargedtoday, q60_remainingbalance, q58_totalamount
 */

export type ServiceType = 'SMALL' | 'MEDIUM' | 'LARGE' | 'TREADMILL' | 'CUSTOM';
export type RushType    = 'SAME_DAY' | 'NEXT_DAY' | 'NO_RUSH';
export type PaymentMode = 'FULL' | 'DEPOSIT';

export const CURRENT_PRICE_VERSION = 5;

// ── Price tables ────────────────────────────────────────────────────────────

const BASE_PRICES: Record<ServiceType, number> = {
  SMALL:     7900,   // $79.00
  MEDIUM:    12900,  // $129.00
  LARGE:     19900,  // $199.00
  TREADMILL: 14900,  // $149.00
  CUSTOM:    0,      // requires manual quote
};

const RUSH_FEES: Record<RushType, number> = {
  SAME_DAY: 3000,  // $30.00
  NEXT_DAY:  2000,  // $20.00
  NO_RUSH:   0,
};

// ── Jotform field parsers ───────────────────────────────────────────────────

/**
 * Parse q48_typeA48 → RushType
 *   "Same-day (+30)" → SAME_DAY
 *   "Next-day (+20)" → NEXT_DAY
 *   ""  / null / any → NO_RUSH
 */
export function parseRushType(raw: string | null | undefined): RushType {
  if (!raw) return 'NO_RUSH';
  const s = raw.trim().toLowerCase();
  if (s.startsWith('same')) return 'SAME_DAY';
  if (s.startsWith('next')) return 'NEXT_DAY';
  return 'NO_RUSH';
}

/**
 * Parse q7_serviceNeeded → ServiceType
 *   "Small Assembly"              → SMALL
 *   "Medium Assembly"             → MEDIUM
 *   "Large Assembly"              → LARGE
 *   "Treadmill Assembly"          → TREADMILL
 *   "Custom Job (Quote Required)" → CUSTOM
 */
export function parseServiceType(raw: string | null | undefined): ServiceType {
  if (!raw) return 'CUSTOM';
  const s = raw.trim().toLowerCase();
  if (s.startsWith('small'))     return 'SMALL';
  if (s.startsWith('medium'))    return 'MEDIUM';
  if (s.startsWith('large'))     return 'LARGE';
  if (s.startsWith('treadmill')) return 'TREADMILL';
  return 'CUSTOM';
}

/**
 * Parse q43_typeA43 → PaymentMode
 *   "Pay in Full" → FULL
 *   "Pay Deposit" → DEPOSIT
 *   default       → FULL
 */
export function parsePaymentMode(raw: string | null | undefined): PaymentMode {
  if (!raw) return 'FULL';
  return raw.trim().toLowerCase().includes('deposit') ? 'DEPOSIT' : 'FULL';
}

// ── Pricing result ──────────────────────────────────────────────────────────

export interface PricingResult {
  base_price_cents:          number;
  rush_fee_cents:            number;
  authorized_total_cents:    number;
  deposit_amount_cents:      number;
  remaining_balance_cents:   number;
  price_version:             number;
  rush_type:                 RushType;
  service_type:              ServiceType;
  payment_mode:              PaymentMode;
  display: {
    base_price:        string;
    rush_fee:          string | null;
    authorized_total:  string;
    deposit_amount:    string;
    remaining_balance: string;
  };
}

function formatCents(cents: number): string {
  return '$' + (cents / 100).toFixed(2);
}

export function calculatePricing(
  serviceType: ServiceType,
  rushType: RushType,
  paymentMode: PaymentMode,
  priceVersion: number = CURRENT_PRICE_VERSION,
): PricingResult {
  const base    = BASE_PRICES[serviceType];
  const rush    = RUSH_FEES[rushType];
  const total   = base + rush;
  const deposit = Math.floor(total / 2);
  const remaining = total - deposit;

  const chargedNow = paymentMode === 'FULL' ? total : deposit;
  const chargedLater = paymentMode === 'FULL' ? 0 : remaining;

  return {
    base_price_cents:          base,
    rush_fee_cents:            rush,
    authorized_total_cents:    total,
    deposit_amount_cents:      chargedNow,
    remaining_balance_cents:   chargedLater,
    price_version:             priceVersion,
    rush_type:                 rushType,
    service_type:              serviceType,
    payment_mode:              paymentMode,
    display: {
      base_price:        formatCents(base),
      rush_fee:          rush > 0 ? formatCents(rush) : null,
      authorized_total:  formatCents(total),
      deposit_amount:    formatCents(chargedNow),
      remaining_balance: formatCents(chargedLater),
    },
  };
}

// ── Legacy compat shims (used by existing tests) ────────────────────────────

export function computePrice(
  serviceType: ServiceType,
  rush: boolean,
  priceVersion: number = CURRENT_PRICE_VERSION,
): { basePrice: number; rushFee: number; quotedTotal: number; depositAmount: number; priceVersion: number } {
  const rushType = rush ? 'SAME_DAY' : 'NO_RUSH';
  const r = calculatePricing(serviceType, rushType, 'DEPOSIT', priceVersion);
  return {
    basePrice:     r.base_price_cents,
    rushFee:       r.rush_fee_cents,
    quotedTotal:   r.authorized_total_cents,
    depositAmount: r.deposit_amount_cents,
    priceVersion,
  };
}

export function verifyPaymentAmount(
  storedAmount: number,
  webhookAmount: number,
): { ok: boolean; expected: number; received: number } {
  return { ok: storedAmount === webhookAmount, expected: storedAmount, received: webhookAmount };
}

export function calculateRemainder(quotedTotal: number, depositAmount: number): number {
  return quotedTotal - depositAmount;
}

// Re-export legacy type alias for existing code
export type { PricingResult as LegacyPricingResult };
