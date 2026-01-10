import { describe, it, expect } from 'vitest'
import { normalizePhone, phonesMatch, toRedisPhone, quickNormalizePhone } from '@/src/lib/phone'

describe('Phone Normalization - Canonical Function', () => {
  describe('normalizePhone()', () => {
    it('should normalize +14155551234 to E.164 format', () => {
      expect(normalizePhone('+14155551234')).toBe('+14155551234')
    })

    it('should normalize 14155551234 to E.164 format', () => {
      expect(normalizePhone('14155551234')).toBe('+14155551234')
    })

    it('should normalize (415) 555-1234 to E.164 format', () => {
      expect(normalizePhone('(415) 555-1234')).toBe('+14155551234')
    })

    it('should normalize 415-555-1234 to E.164 format', () => {
      expect(normalizePhone('415-555-1234')).toBe('+14155551234')
    })

    it('should normalize 4155551234 to E.164 format', () => {
      expect(normalizePhone('4155551234')).toBe('+14155551234')
    })

    it('should normalize +1 (415) 555-1234 with spaces and parens', () => {
      expect(normalizePhone('+1 (415) 555-1234')).toBe('+14155551234')
    })

    it('should normalize 1-415-555-1234 with dashes', () => {
      expect(normalizePhone('1-415-555-1234')).toBe('+14155551234')
    })

    it('should return null for empty string', () => {
      expect(normalizePhone('')).toBeNull()
    })

    it('should return null for null input', () => {
      expect(normalizePhone(null)).toBeNull()
    })

    it('should return null for undefined input', () => {
      expect(normalizePhone(undefined)).toBeNull()
    })

    it('should return null for short numbers (less than 10 digits)', () => {
      expect(normalizePhone('555-1234')).toBeNull()
    })

    it('should return null for invalid input like text', () => {
      expect(normalizePhone('not a phone')).toBeNull()
    })

    it('should handle whitespace around valid numbers', () => {
      expect(normalizePhone('  4155551234  ')).toBe('+14155551234')
    })
  })

  describe('phonesMatch()', () => {
    it('should match same E.164 numbers', () => {
      expect(phonesMatch('+14155551234', '+14155551234')).toBe(true)
    })

    it('should match different formats of same number', () => {
      expect(phonesMatch('(415) 555-1234', '+14155551234')).toBe(true)
    })

    it('should match 10-digit with E.164', () => {
      expect(phonesMatch('4155551234', '+14155551234')).toBe(true)
    })

    it('should not match different numbers', () => {
      expect(phonesMatch('4155551234', '4155551235')).toBe(false)
    })

    it('should return false if either is null', () => {
      expect(phonesMatch(null, '+14155551234')).toBe(false)
      expect(phonesMatch('+14155551234', null)).toBe(false)
    })

    it('should return false if either is invalid', () => {
      expect(phonesMatch('invalid', '+14155551234')).toBe(false)
    })
  })
})

describe('toRedisPhone() - 10-Digit Format for Redis', () => {
  // The system uses 10-digit format for Redis keys (without +1 prefix)
  // This is the canonical function for Redis phone storage

  it('should convert E.164 to 10-digit', () => {
    expect(toRedisPhone('+14155551234')).toBe('4155551234')
  })

  it('should convert formatted number to 10-digit', () => {
    expect(toRedisPhone('(415) 555-1234')).toBe('4155551234')
  })

  it('should convert 11-digit to 10-digit', () => {
    expect(toRedisPhone('14155551234')).toBe('4155551234')
  })

  it('should pass through 10-digit already', () => {
    expect(toRedisPhone('4155551234')).toBe('4155551234')
  })

  it('should handle longer numbers by taking last 10 digits', () => {
    expect(toRedisPhone('+14155551234')).toBe('4155551234')
  })

  it('should return null for null input', () => {
    expect(toRedisPhone(null)).toBeNull()
  })

  it('should return null for undefined input', () => {
    expect(toRedisPhone(undefined)).toBeNull()
  })

  it('should return null for short numbers', () => {
    expect(toRedisPhone('555-1234')).toBeNull()
  })
})

describe('quickNormalizePhone() - Fast E.164 Normalization', () => {
  it('should normalize 10-digit to E.164', () => {
    expect(quickNormalizePhone('4155551234')).toBe('+14155551234')
  })

  it('should normalize 11-digit with leading 1 to E.164', () => {
    expect(quickNormalizePhone('14155551234')).toBe('+14155551234')
  })

  it('should normalize formatted number to E.164', () => {
    expect(quickNormalizePhone('(415) 555-1234')).toBe('+14155551234')
  })

  it('should normalize dashed number to E.164', () => {
    expect(quickNormalizePhone('415-555-1234')).toBe('+14155551234')
  })

  it('should return null for null input', () => {
    expect(quickNormalizePhone(null)).toBeNull()
  })

  it('should return null for short numbers', () => {
    expect(quickNormalizePhone('555-1234')).toBeNull()
  })
})

describe('Phone Format Consistency - Critical Bug Check', () => {
  // This documents the BUG: different parts of the codebase use different formats
  // The fix is to standardize on 10-digit for Redis storage

  // What the send route currently does (line 67-70):
  function sendRouteNormalize(phone: string): string {
    return phone.replace(/\D/g, '').slice(-10)
  }

  // What suppression.ts does (line 36-41):
  function suppressionNormalize(phone: string): string {
    const digits = phone.replace(/\D/g, '')
    if (digits.length === 11 && digits.startsWith('1')) {
      return digits.slice(1)
    }
    return digits
  }

  // What webhook (quo/route.ts line 430) does:
  function webhookNormalize(phone: string): string {
    return phone.replace(/\D/g, '').slice(-10)
  }

  it('send route and webhook use same logic', () => {
    const phone = '+14155551234'
    expect(sendRouteNormalize(phone)).toBe(webhookNormalize(phone))
  })

  it('suppression.ts produces same output for E.164', () => {
    const phone = '+14155551234'
    expect(suppressionNormalize(phone)).toBe(sendRouteNormalize(phone))
  })

  it('all normalizers produce same output for formatted phone', () => {
    const phone = '(415) 555-1234'
    const expected = '4155551234'
    expect(sendRouteNormalize(phone)).toBe(expected)
    expect(suppressionNormalize(phone)).toBe(expected)
    expect(webhookNormalize(phone)).toBe(expected)
  })

  it('all normalizers produce same output for 11-digit phone', () => {
    const phone = '14155551234'
    const expected = '4155551234'
    expect(sendRouteNormalize(phone)).toBe(expected)
    expect(suppressionNormalize(phone)).toBe(expected)
    expect(webhookNormalize(phone)).toBe(expected)
  })
})
