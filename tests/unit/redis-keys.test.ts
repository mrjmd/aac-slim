import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

describe('Redis Key Consistency', () => {
  // These tests verify that Redis keys are used consistently across the codebase
  // Critical for opt-out tracking and suppression lists

  const rootDir = join(__dirname, '../..')

  function readFile(path: string): string {
    return readFileSync(join(rootDir, path), 'utf-8')
  }

  describe('ever-messaged key', () => {
    it('send route should use suppression:ever-messaged', () => {
      const sendRoute = readFile('app/api/campaign/send/route.ts')

      // FIXED: The send route now uses 'suppression:ever-messaged'
      const hasCorrectKey = sendRoute.includes("'suppression:ever-messaged'")
      expect(hasCorrectKey).toBe(true)
    })

    it('webhook should use suppression:ever-messaged', () => {
      const webhook = readFile('app/api/webhooks/quo/route.ts')
      expect(webhook).toContain("'suppression:ever-messaged'")
    })

    it('suppression.ts should use suppression:ever-messaged', () => {
      const suppression = readFile('app/lib/suppression.ts')
      expect(suppression).toContain("'suppression:ever-messaged'")
    })

    it('redis.ts should use suppression:ever-messaged', () => {
      const redis = readFile('src/lib/redis.ts')
      expect(redis).toContain("'suppression:ever-messaged'")
    })
  })

  describe('optouts:phones key', () => {
    it('opt-out script should use optouts:phones', () => {
      const script = readFile('scripts/add-optouts-batch.ts')
      expect(script).toContain("'optouts:phones'")
    })

    it('suppression.ts should check optouts:phones', () => {
      const suppression = readFile('app/lib/suppression.ts')
      expect(suppression).toContain("'optouts:phones'")
    })

    it('webhook should add to optouts:phones on STOP', () => {
      const webhook = readFile('app/api/webhooks/quo/route.ts')
      expect(webhook).toContain("'optouts:phones'")
    })
  })

  describe('campaigns:active key', () => {
    it('campaign create should add to campaigns:active', () => {
      const create = readFile('app/api/campaign/create/route.ts')
      expect(create).toContain("'campaigns:active'")
    })

    it('campaign stats should read from campaigns:active', () => {
      const stats = readFile('app/api/campaign/stats/route.ts')
      expect(stats).toContain("'campaigns:active'")
    })
  })

  describe('daily message counter key', () => {
    it('send route should use daily:messages: prefix', () => {
      const sendRoute = readFile('app/api/campaign/send/route.ts')
      expect(sendRoute).toContain('daily:messages:')
    })
  })

  describe('suppression list prefixes', () => {
    const suppressionPrefixes = [
      'suppression:dnc',
      'suppression:litigators',
      'suppression:landlines',
      'suppression:inactive',
    ]

    for (const prefix of suppressionPrefixes) {
      it(`should use ${prefix} consistently`, () => {
        const suppression = readFile('app/lib/suppression.ts')
        expect(suppression).toContain(`'${prefix}'`)
      })
    }
  })

  describe('cache prefixes', () => {
    it('should use cache:verified-clean for SearchBug clean numbers', () => {
      const suppression = readFile('app/lib/suppression.ts')
      expect(suppression).toContain("'cache:verified-clean'")
    })

    it('scrub status should cache verified clean numbers', () => {
      const scrubStatus = readFile('app/api/phones/scrub/status/route.ts')
      // Uses addManyToVerifiedClean from suppression.ts
      expect(scrubStatus).toContain('addManyToVerifiedClean')
    })
  })
})
