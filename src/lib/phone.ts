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

/**
 * Get 10-digit format for Redis storage
 * Redis stores phones as 10-digit strings (no +1 prefix)
 *
 * @example
 * toRedisPhone('+14155551234') // '4155551234'
 * toRedisPhone('(415) 555-1234') // '4155551234'
 * toRedisPhone('14155551234') // '4155551234'
 */
export function toRedisPhone(phone: string | null | undefined): string | null {
  if (!phone) return null;

  // Strip all non-digits
  const digits = phone.replace(/\D/g, '');

  // Handle 11-digit with leading 1 (US country code)
  if (digits.length === 11 && digits.startsWith('1')) {
    return digits.slice(1);
  }

  // Handle 10-digit
  if (digits.length === 10) {
    return digits;
  }

  // For other lengths, take last 10 digits
  if (digits.length > 10) {
    return digits.slice(-10);
  }

  // Too short
  return null;
}

/**
 * Quick normalize without libphonenumber - for performance-critical paths
 * Returns E.164 format for US numbers
 *
 * @example
 * quickNormalizePhone('(415) 555-1234') // '+14155551234'
 * quickNormalizePhone('4155551234') // '+14155551234'
 */
export function quickNormalizePhone(phone: string | null | undefined): string | null {
  if (!phone) return null;

  const digits = phone.replace(/\D/g, '');

  if (digits.length === 10) {
    return `+1${digits}`;
  }

  if (digits.length === 11 && digits.startsWith('1')) {
    return `+${digits}`;
  }

  // For international or weird formats, fall back to null
  // (caller should use full normalizePhone if needed)
  return null;
}
