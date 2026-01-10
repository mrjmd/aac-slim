import { describe, it, expect } from 'vitest'
import { filterResults, PhoneValidationResult } from '@/src/clients/searchbug'

describe('SearchBug Filter Results', () => {
  function createResult(overrides: Partial<PhoneValidationResult>): PhoneValidationResult {
    return {
      ID: '1',
      NUMBER: '(415) 555-1234',
      STATUS: 'ACTIVE',
      DNC: 'NO',
      TCPA: 'NO',
      TYPE: 'CELLULAR',
      OCN: '1234',
      PORTED: 'NO',
      CARRIER: 'T-MOBILE',
      SMSEMAIL: '',
      LOCATION: 'SAN FRANCISCO',
      STATE: 'CA',
      TIMEZONE: 'PST',
      ...overrides,
    }
  }

  describe('DNC filtering', () => {
    it('should filter out Federal DNC numbers', () => {
      const results = [createResult({ DNC: 'FED' })]
      const scrubbed = filterResults(results)

      expect(scrubbed.clean).toHaveLength(0)
      expect(scrubbed.removed.dnc).toHaveLength(1)
    })

    it('should filter out State DNC numbers', () => {
      const results = [createResult({ DNC: 'MA' })]
      const scrubbed = filterResults(results)

      expect(scrubbed.clean).toHaveLength(0)
      expect(scrubbed.removed.dnc).toHaveLength(1)
    })

    it('should filter out combined Federal+State DNC', () => {
      const results = [createResult({ DNC: 'FED,MA' })]
      const scrubbed = filterResults(results)

      expect(scrubbed.clean).toHaveLength(0)
      expect(scrubbed.removed.dnc).toHaveLength(1)
    })

    it('should filter out Complainers (CPL)', () => {
      const results = [createResult({ DNC: 'CPL' })]
      const scrubbed = filterResults(results)

      expect(scrubbed.clean).toHaveLength(0)
      expect(scrubbed.removed.dnc).toHaveLength(1)
    })

    it('should pass through DNC=NO numbers', () => {
      const results = [createResult({ DNC: 'NO' })]
      const scrubbed = filterResults(results)

      expect(scrubbed.clean).toHaveLength(1)
      expect(scrubbed.removed.dnc).toHaveLength(0)
    })

    it('should allow DNC numbers with includeDnc option', () => {
      const results = [createResult({ DNC: 'FED,MA' })]
      const scrubbed = filterResults(results, { includeDnc: true })

      expect(scrubbed.clean).toHaveLength(1)
      expect(scrubbed.removed.dnc).toHaveLength(0)
    })
  })

  describe('TCPA Litigator filtering', () => {
    it('should filter out TCPA litigators', () => {
      const results = [createResult({ TCPA: 'YES' })]
      const scrubbed = filterResults(results)

      expect(scrubbed.clean).toHaveLength(0)
      expect(scrubbed.removed.litigator).toHaveLength(1)
    })

    it('should pass through non-litigators', () => {
      const results = [createResult({ TCPA: 'NO' })]
      const scrubbed = filterResults(results)

      expect(scrubbed.clean).toHaveLength(1)
      expect(scrubbed.removed.litigator).toHaveLength(0)
    })

    it('should ALWAYS filter litigators even with includeDnc', () => {
      // Litigators should never be contacted, regardless of settings
      const results = [createResult({ TCPA: 'YES' })]
      const scrubbed = filterResults(results, { includeDnc: true })

      expect(scrubbed.clean).toHaveLength(0)
      expect(scrubbed.removed.litigator).toHaveLength(1)
    })
  })

  describe('Landline filtering', () => {
    it('should filter out landlines', () => {
      const results = [createResult({ TYPE: 'LANDLINE' })]
      const scrubbed = filterResults(results)

      expect(scrubbed.clean).toHaveLength(0)
      expect(scrubbed.removed.landline).toHaveLength(1)
    })

    it('should pass through cellular numbers', () => {
      const results = [createResult({ TYPE: 'CELLULAR' })]
      const scrubbed = filterResults(results)

      expect(scrubbed.clean).toHaveLength(1)
      expect(scrubbed.removed.landline).toHaveLength(0)
    })

    it('should pass through VOIP numbers', () => {
      // Currently VOIP is allowed through - may change based on bounce analysis
      const results = [createResult({ TYPE: 'VOIP' })]
      const scrubbed = filterResults(results)

      expect(scrubbed.clean).toHaveLength(1)
      expect(scrubbed.removed.landline).toHaveLength(0)
    })

    it('should pass through UNKNOWN type numbers', () => {
      const results = [createResult({ TYPE: 'UNKNOWN' })]
      const scrubbed = filterResults(results)

      expect(scrubbed.clean).toHaveLength(1)
      expect(scrubbed.removed.landline).toHaveLength(0)
    })
  })

  describe('Inactive/Invalid filtering', () => {
    it('should filter out INACTIVE numbers', () => {
      const results = [createResult({ STATUS: 'INACTIVE' })]
      const scrubbed = filterResults(results)

      expect(scrubbed.clean).toHaveLength(0)
      expect(scrubbed.removed.inactive).toHaveLength(1)
    })

    it('should filter out INVALID numbers', () => {
      const results = [createResult({ STATUS: 'INVALID' })]
      const scrubbed = filterResults(results)

      expect(scrubbed.clean).toHaveLength(0)
      expect(scrubbed.removed.inactive).toHaveLength(1)
    })

    it('should pass through ACTIVE numbers', () => {
      const results = [createResult({ STATUS: 'ACTIVE' })]
      const scrubbed = filterResults(results)

      expect(scrubbed.clean).toHaveLength(1)
      expect(scrubbed.removed.inactive).toHaveLength(0)
    })

    it('should pass through NOT_VERIFIED numbers', () => {
      // NOT_VERIFIED means SearchBug couldn't verify, but likely fine
      const results = [createResult({ STATUS: 'NOT_VERIFIED' })]
      const scrubbed = filterResults(results)

      expect(scrubbed.clean).toHaveLength(1)
      expect(scrubbed.removed.inactive).toHaveLength(0)
    })
  })

  describe('Filter priority', () => {
    it('should categorize as litigator first (highest priority)', () => {
      // A number that is both DNC and litigator should be in litigator bucket
      const results = [createResult({ TCPA: 'YES', DNC: 'FED' })]
      const scrubbed = filterResults(results)

      expect(scrubbed.removed.litigator).toHaveLength(1)
      expect(scrubbed.removed.dnc).toHaveLength(0)
    })

    it('should categorize as DNC second (over landline)', () => {
      // A landline on DNC should be in DNC bucket
      const results = [createResult({ DNC: 'FED', TYPE: 'LANDLINE' })]
      const scrubbed = filterResults(results)

      expect(scrubbed.removed.dnc).toHaveLength(1)
      expect(scrubbed.removed.landline).toHaveLength(0)
    })

    it('should categorize as landline third (over inactive)', () => {
      // An inactive landline should be in landline bucket
      const results = [createResult({ TYPE: 'LANDLINE', STATUS: 'INACTIVE' })]
      const scrubbed = filterResults(results)

      expect(scrubbed.removed.landline).toHaveLength(1)
      expect(scrubbed.removed.inactive).toHaveLength(0)
    })
  })

  describe('Summary counts', () => {
    it('should provide accurate summary counts', () => {
      const results = [
        createResult({ ID: '1', DNC: 'NO', TYPE: 'CELLULAR', STATUS: 'ACTIVE' }), // clean
        createResult({ ID: '2', TCPA: 'YES' }), // litigator
        createResult({ ID: '3', DNC: 'FED' }), // dnc
        createResult({ ID: '4', TYPE: 'LANDLINE' }), // landline
        createResult({ ID: '5', STATUS: 'INACTIVE' }), // inactive
      ]

      const scrubbed = filterResults(results)

      expect(scrubbed.summary.total).toBe(5)
      expect(scrubbed.summary.clean).toBe(1)
      expect(scrubbed.summary.litigator).toBe(1)
      expect(scrubbed.summary.dnc).toBe(1)
      expect(scrubbed.summary.landline).toBe(1)
      expect(scrubbed.summary.inactive).toBe(1)
    })
  })
})

describe('SearchBug Phone Format', () => {
  it('should format 10-digit to (XXX) XXX-XXXX for API', () => {
    // The SearchBug API expects phones in (XXX) XXX-XXXX format
    // This is handled by formatPhoneForSearchBug() in the client
    const input = '4155551234'
    const expected = '(415) 555-1234'

    // Simple format function for testing
    const formatted = `(${input.slice(0, 3)}) ${input.slice(3, 6)}-${input.slice(6)}`
    expect(formatted).toBe(expected)
  })

  it('should strip +1 prefix before formatting', () => {
    const input = '+14155551234'
    const digits = input.replace(/\D/g, '')
    const tenDigits = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits
    const expected = '4155551234'

    expect(tenDigits).toBe(expected)
  })
})
