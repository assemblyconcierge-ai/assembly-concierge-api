// ============================================================
// Assembly Concierge MVP v2 — Identifier Generation
//
// Three identity layers per v2 spec §2.2:
//   1. Internal DB: UUID v7 (time-ordered) for all entity PKs
//   2. Cross-system public: AC-XXXX-XXXX job code
//   3. Idempotency: UUID v4 (client-generated, validated here)
// ============================================================

import { v4 as uuidv4, v7 as uuidv7 } from 'uuid';
import { randomBytes } from 'crypto';

// ── Internal IDs (UUID v7 — time-ordered) ───────────────────

/**
 * Generate a UUID v7 for use as a database primary key.
 * Time-ordered for efficient B-tree indexing.
 */
export function generateId(): string {
  return uuidv7();
}

// ── Public Job Code (AC-XXXX-XXXX) ──────────────────────────

// Alphabet excludes I, O, 1, 0 to prevent visual ambiguity
const JOB_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/**
 * Generate a public job code in the format AC-XXXX-XXXX.
 * Uses 8 cryptographically random characters from an unambiguous alphabet.
 * The caller is responsible for uniqueness checking and retry on collision.
 */
export function generatePublicJobCode(): string {
  const bytes = randomBytes(8);
  let code = '';
  for (let i = 0; i < 8; i++) {
    code += JOB_CODE_ALPHABET[bytes[i] % JOB_CODE_ALPHABET.length];
  }
  return `AC-${code.slice(0, 4)}-${code.slice(4)}`;
}

/**
 * Validate that a string matches the AC-XXXX-XXXX job code format.
 */
export function isValidJobCode(code: string): boolean {
  return /^AC-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(code);
}

// ── Idempotency Key (UUID v4 — client-generated) ─────────────

/**
 * Validate that a string is a well-formed UUID v4.
 * Used to reject malformed idempotency keys at the API boundary.
 */
export function isValidUuidV4(key: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(key);
}

/**
 * Generate a UUID v4 (for use in tests and internal tooling).
 */
export function generateIdempotencyKey(): string {
  return uuidv4();
}
