import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

describe('Suppression List Management', () => {
  const rootDir = join(__dirname, '../..')

  function readFile(path: string): string {
    return readFileSync(join(rootDir, path), 'utf-8')
  }

  describe('Suppression list Redis keys', () => {
    const suppressionLists = [
      { name: 'DNC', key: 'suppression:dnc' },
      { name: 'Litigators', key: 'suppression:litigators' },
      { name: 'Landlines', key: 'suppression:landlines' },
      { name: 'Inactive', key: 'suppression:inactive' },
      { name: 'Ever Messaged', key: 'suppression:ever-messaged' },
    ]

    for (const list of suppressionLists) {
      it(`should define ${list.name} list with key ${list.key}`, () => {
        const suppression = readFile('app/lib/suppression.ts')
        expect(suppression).toContain(`'${list.key}'`)
      })
    }
  })

  describe('Cache keys', () => {
    it('should use cache:verified-clean for SearchBug verified numbers', () => {
      const suppression = readFile('app/lib/suppression.ts')
      expect(suppression).toContain("'cache:verified-clean'")
    })
  })

  describe('Opt-out list', () => {
    it('should check optouts:phones in suppression checks', () => {
      const suppression = readFile('app/lib/suppression.ts')
      expect(suppression).toContain("'optouts:phones'")
    })
  })

  describe('Phone format for suppression lists', () => {
    // All suppression lists should store phones in 10-digit format (no +1 prefix)
    // This ensures consistent lookup regardless of input format

    it('suppression.ts should have normalizePhone function', () => {
      const suppression = readFile('app/lib/suppression.ts')
      expect(suppression).toContain('function normalizePhone')
    })

    it('normalizePhone should strip +1 prefix', () => {
      const suppression = readFile('app/lib/suppression.ts')
      // Looking for the pattern that removes country code
      expect(suppression).toMatch(/slice\(1\)|slice\(-10\)|replace\(.*\+1/)
    })
  })
})

describe('Suppression Check Flow', () => {
  describe('Prefilter endpoint', () => {
    it('should check all suppression lists', () => {
      const prefilter = readFileSync(
        join(__dirname, '../../app/api/phones/prefilter/route.ts'),
        'utf-8'
      )

      // Should check DNC
      expect(prefilter).toContain('dnc')

      // Should check litigators
      expect(prefilter).toContain('litigator')

      // Should check landlines
      expect(prefilter).toContain('landline')

      // Should check inactive
      expect(prefilter).toContain('inactive')

      // Should check opt-outs
      expect(prefilter).toContain('optout')
    })

    it('should check previously messaged numbers', () => {
      const prefilter = readFileSync(
        join(__dirname, '../../app/api/phones/prefilter/route.ts'),
        'utf-8'
      )

      // Uses checkManyEverMessaged function from suppression.ts
      expect(prefilter).toContain('everMessaged')
    })
  })

  describe('Send route pre-send checks', () => {
    it('should check opt-outs before sending', () => {
      const sendRoute = readFileSync(
        join(__dirname, '../../app/api/campaign/send/route.ts'),
        'utf-8'
      )

      expect(sendRoute).toContain('optouts:phones')
    })
  })
})
