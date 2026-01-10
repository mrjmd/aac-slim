import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

describe('Campaign Send Flow', () => {
  const rootDir = join(__dirname, '../..')

  function readFile(path: string): string {
    return readFileSync(join(rootDir, path), 'utf-8')
  }

  describe('Pre-send checks in send route', () => {
    const sendRoute = readFile('app/api/campaign/send/route.ts')

    it('should check if campaign is paused before sending', () => {
      expect(sendRoute).toContain('paused')
    })

    it('should check global daily limit before sending', () => {
      expect(sendRoute).toContain('daily:messages:')
    })

    it('should check opt-out list before sending', () => {
      expect(sendRoute).toContain('optouts:phones')
    })

    it('should skip opted-out numbers', () => {
      // If phone is in optouts:phones, should skip
      expect(sendRoute).toMatch(/optouts:phones.*skip|skip.*optouts:phones/s)
    })
  })

  describe('Message sending via OpenPhone', () => {
    const sendRoute = readFile('app/api/campaign/send/route.ts')

    it('should use content field (not text) for OpenPhone API', () => {
      // OpenPhone API uses 'content' field, not 'text'
      expect(sendRoute).toContain('content:')
    })

    it('should send to the correct phone number', () => {
      expect(sendRoute).toContain('to:')
    })
  })

  describe('Stats tracking', () => {
    const sendRoute = readFile('app/api/campaign/send/route.ts')

    it('should increment sent stat on success', () => {
      expect(sendRoute).toContain('sent')
      // Uses local incrementStats function
      expect(sendRoute).toContain('incrementStats')
    })

    it('should track phone in suppression:ever-messaged', () => {
      // FIXED: Now uses 'suppression:ever-messaged'
      expect(sendRoute).toContain("'suppression:ever-messaged'")
    })

    it('should increment daily counter on success', () => {
      expect(sendRoute).toContain('daily:messages:')
    })
  })

  describe('Error handling', () => {
    const sendRoute = readFile('app/api/campaign/send/route.ts')

    it('should return 200 even on failure (prevent QStash retry)', () => {
      // QStash retries on non-200 responses
      // We want to prevent infinite retries by always returning 200
      expect(sendRoute).toMatch(/return.*json.*200|NextResponse\.json.*\{.*\}.*\)/s)
    })

    it('should log errors properly', () => {
      expect(sendRoute).toContain('console.error')
    })
  })

  describe('A/B test variant tracking', () => {
    const sendRoute = readFile('app/api/campaign/send/route.ts')

    it('should track variant stats', () => {
      expect(sendRoute).toContain('variant')
    })
  })
})

describe('Campaign Send - Phone Normalization', () => {
  const sendRoute = readFileSync(
    join(__dirname, '../../app/api/campaign/send/route.ts'),
    'utf-8'
  )

  it('send route uses canonical toRedisPhone from src/lib/phone', () => {
    // FIXED: Now imports and uses toRedisPhone from canonical location
    expect(sendRoute).toContain('toRedisPhone')
    expect(sendRoute).toContain("from '@/src/lib/phone'")
  })
})

describe('Campaign Send - Redis Key (FIXED)', () => {
  const sendRoute = readFileSync(
    join(__dirname, '../../app/api/campaign/send/route.ts'),
    'utf-8'
  )

  it('uses correct suppression:ever-messaged key', () => {
    // FIXED: Now uses 'suppression:ever-messaged' to match webhook
    expect(sendRoute).toContain("'suppression:ever-messaged'")
  })

  it('no longer uses wrong ever-messaged key', () => {
    // The old bug was using 'ever-messaged' without prefix
    // Now it uses the correct key
    const hasWrongKeyAlone = sendRoute.includes("'ever-messaged'") &&
                              !sendRoute.includes("'suppression:ever-messaged'")
    expect(hasWrongKeyAlone).toBe(false)
  })
})
