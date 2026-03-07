// ============================================================
// Assembly Concierge v6 — Webhook Security
//
// Supports two verification modes:
// 1. GENERIC (X-Webhook-Signature header) — for Make.com forwarding
// 2. STRIPE (Stripe-Signature header) — for direct Stripe delivery
//
// Both use timing-safe HMAC-SHA256 comparison.
// ============================================================

import { createHmac, timingSafeEqual } from 'crypto';

export const WEBHOOK_SECRET_ENV_KEY = 'AC_WEBHOOK_SECRET';
const STRIPE_TOLERANCE_SECONDS = 300;

// ── Generic HMAC-SHA256 ──────────────────────────────────────

export function computeSignature(secret: string, rawBody: string | Buffer): string {
  return createHmac('sha256', secret).update(rawBody).digest('hex');
}

export function verifySignature(
  rawBody: string | Buffer,
  providedSig: string,
  secret: string,
): boolean {
  if (!providedSig) return false;
  const expected = computeSignature(secret, rawBody);
  try {
    return timingSafeEqual(
      Buffer.from(expected, 'hex'),
      Buffer.from(providedSig, 'hex'),
    );
  } catch {
    return false;
  }
}

// ── Stripe stripe-signature header ──────────────────────────

export function parseStripeSignatureHeader(header: string): { timestamp: number; signatures: string[] } | null {
  if (!header) return null;
  const parts = header.split(',');
  let timestamp = 0;
  const signatures: string[] = [];
  for (const part of parts) {
    const eqIdx = part.indexOf('=');
    if (eqIdx === -1) continue;
    const key = part.slice(0, eqIdx);
    const value = part.slice(eqIdx + 1);
    if (key === 't') timestamp = parseInt(value, 10);
    else if (key === 'v1') signatures.push(value);
  }
  if (!timestamp || signatures.length === 0) return null;
  return { timestamp, signatures };
}

export function verifyStripeSignature(
  rawBody: string | Buffer,
  stripeHeader: string,
  secret: string,
  toleranceSeconds = STRIPE_TOLERANCE_SECONDS,
): boolean {
  if (!stripeHeader || !secret) return false;
  const parsed = parseStripeSignatureHeader(stripeHeader);
  if (!parsed) return false;
  const { timestamp, signatures } = parsed;
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSeconds - timestamp) > toleranceSeconds) return false;
  const bodyStr = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');
  const signedPayload = `${timestamp}.${bodyStr}`;
  const expected = createHmac('sha256', secret).update(signedPayload, 'utf8').digest('hex');
  for (const sig of signatures) {
    try {
      if (timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(sig, 'hex'))) return true;
    } catch { /* length mismatch */ }
  }
  return false;
}

/**
 * Unified inbound webhook verification.
 * Tries Stripe-Signature first, then X-Webhook-Signature (Make forwarding).
 */
export function verifyInboundWebhook(
  rawBody: Buffer,
  headers: Record<string, string | string[] | undefined>,
  genericSecret: string,
  stripeSecret?: string,
): { valid: boolean; mode: 'stripe' | 'generic' | 'none' } {
  const stripeHeader = headers['stripe-signature'] as string | undefined;
  const genericHeader = headers['x-webhook-signature'] as string | undefined;
  if (stripeHeader && stripeSecret) {
    return { valid: verifyStripeSignature(rawBody, stripeHeader, stripeSecret), mode: 'stripe' };
  }
  if (genericHeader) {
    return { valid: verifySignature(rawBody, genericHeader, genericSecret), mode: 'generic' };
  }
  return { valid: false, mode: 'none' };
}

// ── Legacy aliases ───────────────────────────────────────────

export function verifyWebhookSignature(
  secret: string,
  rawBody: string | Buffer,
  providedSig: string,
): boolean {
  return verifySignature(rawBody, providedSig, secret);
}

export function signPayload(secret: string, rawBody: string | Buffer): string {
  return computeSignature(secret, rawBody);
}
