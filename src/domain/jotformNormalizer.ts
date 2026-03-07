/**
 * Assembly Concierge — Jotform Payload Normalizer v5
 *
 * Converts the raw Jotform webhook body into the canonical
 * NormalizedIntake shape used by the intake endpoint.
 *
 * Field mapping (source of truth):
 *   q3_fullName.first + .last  → customer_name
 *   q4_email                   → customer_email
 *   q5_phoneNumber.full        → customer_phone (normalized to E.164)
 *   q6_streetNumberstreet      → address fields
 *   q26_typeA26                → service_city
 *   q38_address.state          → state
 *   q38_address.postal         → zip_code
 *   q7_serviceNeeded           → service_type (parsed)
 *   q48_typeA48                → rush_type (parsed)
 *   q43_typeA43                → payment_mode (parsed)
 *   q9_preferredDate           → appointment_date
 *   q11_preferredTime          → appointment_window
 *   q13_notesFor               → customer_notes
 *   q52_areaTag                → area_tag (raw)
 *   temp_upload.q12_uploadA[]  → photos (merged)
 *   temp_upload.q72_uploadPhoto[] → photos (merged)
 *   uploadA[]                  → photos (merged, resolved URLs)
 *   uploadPhoto[]              → photos (merged, resolved URLs)
 *   submissionID               → submission_id (idempotency key)
 *   q65_isoAppointment         → appointment_date_iso
 *
 * IGNORED: q44_calculation, q51_myProducts, q46_typeA46,
 *          q59_amountchargedtoday, q60_remainingbalance, q58_totalamount
 */

import { parseRushType, parseServiceType, parsePaymentMode } from './pricing.js';
import type { RushType, ServiceType, PaymentMode } from './pricing.js';

// ── Phone normalization ─────────────────────────────────────────────────────

/**
 * Normalize a US phone number to E.164 format (+1XXXXXXXXXX).
 * Strips all non-digit characters, prepends +1 if 10 digits.
 * Returns null if the number cannot be normalized.
 */
export function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 10) return '+1' + digits;
  if (digits.length === 11 && digits.startsWith('1')) return '+' + digits;
  return null;
}

// ── Area status ─────────────────────────────────────────────────────────────

export type AreaStatus = 'IN_AREA' | 'OUTSIDE_AREA';

/**
 * Derive area_status from the q52_areaTag field.
 * "INSIDE - ..." → IN_AREA
 * "OUTSIDE - ..." → OUTSIDE_AREA
 * default → OUTSIDE_AREA (safe default)
 */
export function parseAreaStatus(areaTag: string | null | undefined): AreaStatus {
  if (!areaTag) return 'OUTSIDE_AREA';
  return areaTag.trim().toUpperCase().startsWith('INSIDE') ? 'IN_AREA' : 'OUTSIDE_AREA';
}

// ── Photo URL extraction ────────────────────────────────────────────────────

/**
 * Merge all photo arrays from the Jotform payload into a single string[].
 * Prefers resolved URLs (uploadA, uploadPhoto) over temp_upload filenames.
 */
export function extractPhotos(payload: Record<string, any>): string[] {
  const photos: string[] = [];

  // Resolved URLs (preferred)
  const uploadA = payload['uploadA'];
  if (Array.isArray(uploadA)) photos.push(...uploadA.filter(Boolean));

  const uploadPhoto = payload['uploadPhoto'];
  if (Array.isArray(uploadPhoto)) photos.push(...uploadPhoto.filter(Boolean));

  // Fallback: temp_upload filenames (less useful but captured)
  const tempUpload = payload['temp_upload'] ?? {};
  const q12 = tempUpload['q12_uploadA'];
  if (Array.isArray(q12)) {
    for (const f of q12) {
      const name = typeof f === 'string' ? f.split('#')[0] : null;
      if (name && !photos.some(p => p.includes(name))) photos.push(name);
    }
  }
  const q72 = tempUpload['q72_uploadPhoto'];
  if (Array.isArray(q72)) {
    for (const f of q72) {
      const name = typeof f === 'string' ? f.split('#')[0] : null;
      if (name && !photos.some(p => p.includes(name))) photos.push(name);
    }
  }

  return photos;
}

// ── Appointment date ────────────────────────────────────────────────────────

function buildDateString(obj: { year?: string; month?: string; day?: string } | null | undefined): string | null {
  if (!obj || !obj.year || !obj.month || !obj.day) return null;
  const y = obj.year.padStart(4, '0');
  const m = obj.month.padStart(2, '0');
  const d = obj.day.padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// ── Canonical intake shape ──────────────────────────────────────────────────

export interface NormalizedIntake {
  // Identity
  submission_id:       string;
  idempotency_key:     string;  // same as submission_id

  // Customer
  customer_name:       string;
  customer_email:      string;
  customer_phone_raw:  string;
  customer_phone_e164: string | null;

  // Address
  address_line1:       string;
  address_line2:       string | null;
  service_city:        string;
  state:               string;
  zip_code:            string;
  customer_address:    string;  // full combined string for Airtable

  // Service
  service_type:        ServiceType;
  rush_type:           RushType;
  payment_mode:        PaymentMode;
  appointment_date:    string | null;
  appointment_window:  string | null;
  customer_notes:      string | null;
  photos:              string[];

  // Area
  area_tag:            string;
  area_status:         AreaStatus;
}

// ── Main normalizer ─────────────────────────────────────────────────────────

export function normalizeJotformPayload(raw: Record<string, any>): NormalizedIntake {
  // Name
  const nameObj = raw['q3_fullName'] ?? {};
  const first = (nameObj['first'] ?? '').trim();
  const last  = (nameObj['last']  ?? '').trim();
  const customer_name = [first, last].filter(Boolean).join(' ');

  // Email
  const customer_email = (raw['q4_email'] ?? '').trim();

  // Phone — ONLY q5_phoneNumber.full per spec
  const phoneObj = raw['q5_phoneNumber'] ?? {};
  const customer_phone_raw  = (phoneObj['full'] ?? '').trim();
  const customer_phone_e164 = normalizePhone(customer_phone_raw);

  // Address
  const addrObj   = raw['q6_streetNumberstreet'] ?? {};
  const addr38    = raw['q38_address'] ?? {};
  const address_line1 = (addrObj['addr_line1'] ?? '').trim();
  const address_line2 = (addrObj['addr_line2'] ?? '').trim() || null;
  const service_city  = (raw['q26_typeA26'] ?? '').trim();
  const state         = (addr38['state']  ?? '').trim();
  const zip_code      = (addr38['postal'] ?? '').trim();
  const customer_address = [
    address_line1,
    address_line2,
    service_city,
    state,
    zip_code,
  ].filter(Boolean).join(', ');

  // Service
  const service_type   = parseServiceType(raw['q7_serviceNeeded']);
  const rush_type      = parseRushType(raw['q48_typeA48']);
  const payment_mode   = parsePaymentMode(raw['q43_typeA43']);

  // Appointment
  const appointment_date   = buildDateString(raw['q65_isoAppointment'] ?? raw['q9_preferredDate']);
  const appointment_window = (raw['q11_preferredTime'] ?? '').trim() || null;
  const customer_notes     = (raw['q13_notesFor'] ?? '').trim() || null;

  // Photos
  const photos = extractPhotos(raw);

  // Area
  const area_tag    = (raw['q52_areaTag'] ?? '').trim();
  const area_status = parseAreaStatus(area_tag);

  // Submission ID
  const submission_id = String(raw['submissionID'] ?? raw['q20_uniqueId'] ?? '');

  return {
    submission_id,
    idempotency_key: submission_id,
    customer_name,
    customer_email,
    customer_phone_raw,
    customer_phone_e164,
    address_line1,
    address_line2,
    service_city,
    state,
    zip_code,
    customer_address,
    service_type,
    rush_type,
    payment_mode,
    appointment_date,
    appointment_window,
    customer_notes,
    photos,
    area_tag,
    area_status,
  };
}
