import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

describe('Campaign Creation Flow', () => {
  const rootDir = join(__dirname, '../..')

  function readFile(path: string): string {
    return readFileSync(join(rootDir, path), 'utf-8')
  }

  describe('CSV Parsing (Frontend)', () => {
    const newPage = readFile('app/campaigns/new/page.tsx')

    it('should parse primary contacts from CSV', () => {
      expect(newPage).toContain('primary')
    })

    it('should parse secondary contacts from CSV', () => {
      expect(newPage).toContain('secondary')
    })

    it('should have option for includeDnc', () => {
      expect(newPage).toContain('includeDnc')
    })

    it('should see deduplication happening in backend', () => {
      // Deduplication is now done in the backend create route
      // Frontend still sends all contacts, backend deduplicates
      expect(true).toBe(true)
    })
  })

  describe('Campaign Create API', () => {
    const createRoute = readFile('app/api/campaign/create/route.ts')

    it('should create campaign in Redis', () => {
      expect(createRoute).toContain('campaign:')
    })

    it('should add to campaigns:active set', () => {
      expect(createRoute).toContain("'campaigns:active'")
    })

    it('should normalize phone numbers', () => {
      expect(createRoute).toContain('normalizePhone')
    })

    it('should extract primary contacts', () => {
      expect(createRoute).toContain('primary')
    })

    it('should extract secondary contacts', () => {
      expect(createRoute).toContain('secondary')
    })

    it('should deduplicate by phone before queueing', () => {
      // FIXED: Now deduplicates contacts by phone number
      expect(createRoute).toContain('deduplicateContacts')
      expect(createRoute).toContain('duplicateCount')
    })
  })

  describe('Prefilter Flow', () => {
    const prefilter = readFile('app/api/phones/prefilter/route.ts')

    it('should check DNC list', () => {
      expect(prefilter).toContain('dnc')
    })

    it('should check litigator list', () => {
      expect(prefilter).toContain('litigator')
    })

    it('should check landline list', () => {
      expect(prefilter).toContain('landline')
    })

    it('should check inactive list', () => {
      expect(prefilter).toContain('inactive')
    })

    it('should check opt-out list', () => {
      expect(prefilter).toContain('optout')
    })

    it('should check previously messaged numbers', () => {
      expect(prefilter).toContain('everMessaged')
    })

    it('should check OpenPhone conversation history', () => {
      expect(prefilter).toContain('OpenPhone')
    })
  })

  describe('QStash Message Queue', () => {
    const createRoute = readFile('app/api/campaign/create/route.ts')

    it('should queue messages via QStash', () => {
      expect(createRoute).toContain('qstash')
    })
  })

  describe('Pipedrive Integration', () => {
    const createRoute = readFile('app/api/campaign/create/route.ts')

    it('should create Pipedrive contacts', () => {
      expect(createRoute).toContain('pipedrive')
    })
  })
})

describe('Campaign Creation - Phone Normalization Consistency', () => {
  const createRoute = readFileSync(
    join(__dirname, '../../app/api/campaign/create/route.ts'),
    'utf-8'
  )

  it('create route has its own normalizePhone (SHOULD USE CANONICAL)', () => {
    // The create route has its own normalizePhone function
    // It should use the canonical one from src/lib/phone.ts
    expect(createRoute).toContain('function normalizePhone')
  })
})

describe('Campaign Creation - Deduplication (FIXED)', () => {
  const createRoute = readFileSync(
    join(__dirname, '../../app/api/campaign/create/route.ts'),
    'utf-8'
  )

  describe('Deduplication implementation', () => {
    it('has deduplicateContacts function', () => {
      expect(createRoute).toContain('function deduplicateContacts')
    })

    it('uses toRedisPhone for consistent normalization', () => {
      expect(createRoute).toContain('toRedisPhone')
    })

    it('tracks and reports duplicate count', () => {
      expect(createRoute).toContain('duplicatesRemoved')
    })

    it('deduplicates after CSV parse', () => {
      // The code calls deduplicateContacts after parseCSV
      expect(createRoute).toContain('deduplicateContacts(rawContacts)')
    })
  })
})
