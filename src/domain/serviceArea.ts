// ============================================================
// Assembly Concierge MVP — Service Area Checker
//
// In production this would call a geocoding API and compare
// resolved coordinates against service area polygons.
// In the MVP, we use a normalized city name allowlist.
// ============================================================

import type { AreaStatus } from './types.js';

/** Canonical list of served cities (lowercase, trimmed). */
export const SERVICE_AREA_CITIES = new Set([
  'austin',
  'round rock',
  'cedar park',
  'pflugerville',
  'georgetown',
  'kyle',
  'buda',
  'manor',
  'leander',
]);

/**
 * Determine whether a city is within the service area.
 * Returns IN_AREA or OUTSIDE_AREA.
 */
export function checkServiceArea(city: string): AreaStatus {
  const normalized = city.toLowerCase().trim();
  return SERVICE_AREA_CITIES.has(normalized) ? 'IN_AREA' : 'OUTSIDE_AREA';
}

/**
 * Simulate geocoding: extract city from a raw address string.
 * In production, replace with a real geocoding API call.
 * Returns null if the city cannot be resolved.
 */
export function geocodeAddress(rawAddress: string): {
  resolvedCity: string | null;
  resolvedZip: string | null;
} {
  // Simple heuristic: look for known city names in the address string
  const lower = rawAddress.toLowerCase();
  for (const city of SERVICE_AREA_CITIES) {
    if (lower.includes(city)) {
      // Extract ZIP if present (5-digit pattern)
      const zipMatch = rawAddress.match(/\b(\d{5})\b/);
      return {
        resolvedCity: city.replace(/\b\w/g, c => c.toUpperCase()),
        resolvedZip: zipMatch ? zipMatch[1] : null,
      };
    }
  }
  // Try to extract city from "Street, City, State ZIP" format
  const parts = rawAddress.split(',').map(p => p.trim());
  if (parts.length >= 2) {
    const cityPart = parts[1].trim();
    const zipMatch = rawAddress.match(/\b(\d{5})\b/);
    return {
      resolvedCity: cityPart,
      resolvedZip: zipMatch ? zipMatch[1] : null,
    };
  }
  return { resolvedCity: null, resolvedZip: null };
}
