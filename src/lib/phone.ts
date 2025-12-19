/**
 * Phone number normalization utilities
 * Converts various phone formats to E.164 standard (+15551234567)
 */

import { parsePhoneNumberFromString, CountryCode } from 'libphonenumber-js';

// Default country for parsing numbers without country code
const DEFAULT_COUNTRY: CountryCode = 'US';

export interface NormalizeResult {
  e164: string;
  national: string;
  country: string;
}

/**
 * Normalize a phone number to E.164 format
 * @param phone - Raw phone number in any format
 * @param defaultCountry - Country code to assume if not specified (default: US)
 * @returns E.164 formatted number or null if invalid
 *
 * @example
 * normalizePhone('(555) 123-4567') // '+15551234567'
 * normalizePhone('555-123-4567')   // '+15551234567'
 * normalizePhone('+1 555 123 4567') // '+15551234567'
 * normalizePhone('invalid')        // null
 */
export function normalizePhone(
  phone: string | null | undefined,
  defaultCountry: CountryCode = DEFAULT_COUNTRY
): string | null {
  if (!phone) return null;

  // Clean up the input - remove common noise
  const cleaned = phone.trim();
  if (!cleaned) return null;

  try {
    const parsed = parsePhoneNumberFromString(cleaned, defaultCountry);

    // Accept any number that can be parsed to E.164, even if not "valid"
    // This handles test data and unusual numbers in CRMs
    if (!parsed) {
      return null;
    }

    // Must have at least 10 digits for US numbers
    const e164 = parsed.format('E.164');
    if (e164.length < 11) { // +1 plus 10 digits
      return null;
    }

    return e164;
  } catch {
    // libphonenumber can throw on malformed input
    return null;
  }
}

/**
 * Get detailed phone number info
 * @returns Full parse result or null if invalid
 */
export function parsePhone(
  phone: string | null | undefined,
  defaultCountry: CountryCode = DEFAULT_COUNTRY
): NormalizeResult | null {
  if (!phone) return null;

  try {
    const parsed = parsePhoneNumberFromString(phone.trim(), defaultCountry);

    if (!parsed || !parsed.isValid()) {
      return null;
    }

    return {
      e164: parsed.format('E.164'),
      national: parsed.formatNational(),
      country: parsed.country || defaultCountry,
    };
  } catch {
    return null;
  }
}

/**
 * Check if two phone numbers are the same (comparing E.164 format)
 */
export function phonesMatch(
  phone1: string | null | undefined,
  phone2: string | null | undefined
): boolean {
  const normalized1 = normalizePhone(phone1);
  const normalized2 = normalizePhone(phone2);

  if (!normalized1 || !normalized2) return false;
  return normalized1 === normalized2;
}
