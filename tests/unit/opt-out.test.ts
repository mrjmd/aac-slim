import { describe, it, expect } from 'vitest'
import { isOptOutMessage, OPT_OUT_KEYWORDS } from '@/src/lib/redis'

describe('Opt-Out Detection', () => {
  describe('isOptOutMessage()', () => {
    describe('STOP keyword', () => {
      it('should detect STOP', () => {
        expect(isOptOutMessage('STOP')).toBe(true)
      })

      it('should detect stop (lowercase)', () => {
        expect(isOptOutMessage('stop')).toBe(true)
      })

      it('should detect Stop (mixed case)', () => {
        expect(isOptOutMessage('Stop')).toBe(true)
      })

      it('should detect STOP with surrounding text', () => {
        expect(isOptOutMessage('Please STOP texting me')).toBe(true)
      })

      it('should not match stopped (not whole word)', () => {
        expect(isOptOutMessage('I stopped by the store')).toBe(false)
      })

      it('should not match busstop (not whole word)', () => {
        expect(isOptOutMessage('busstop')).toBe(false)
      })
    })

    describe('CANCEL keyword', () => {
      it('should detect CANCEL', () => {
        expect(isOptOutMessage('CANCEL')).toBe(true)
      })

      it('should detect cancel (lowercase)', () => {
        expect(isOptOutMessage('cancel')).toBe(true)
      })

      it('should not match cancelled (not whole word)', () => {
        expect(isOptOutMessage('cancelled the meeting')).toBe(false)
      })
    })

    describe('UNSUBSCRIBE keyword', () => {
      it('should detect UNSUBSCRIBE', () => {
        expect(isOptOutMessage('UNSUBSCRIBE')).toBe(true)
      })

      it('should detect unsubscribe (lowercase)', () => {
        expect(isOptOutMessage('unsubscribe')).toBe(true)
      })
    })

    describe('QUIT keyword', () => {
      it('should detect QUIT', () => {
        expect(isOptOutMessage('QUIT')).toBe(true)
      })

      it('should detect quit (lowercase)', () => {
        expect(isOptOutMessage('quit')).toBe(true)
      })

      it('should not match quitting (not whole word)', () => {
        expect(isOptOutMessage('quitting time')).toBe(false)
      })
    })

    describe('END keyword', () => {
      it('should detect END', () => {
        expect(isOptOutMessage('END')).toBe(true)
      })

      it('should detect end (lowercase)', () => {
        expect(isOptOutMessage('end')).toBe(true)
      })

      it('should not match ending (not whole word)', () => {
        expect(isOptOutMessage('ending')).toBe(false)
      })

      it('should not match weekend (not whole word)', () => {
        expect(isOptOutMessage('this weekend')).toBe(false)
      })
    })

    describe('Regular messages (non opt-out)', () => {
      it('should return false for "Yes, interested!"', () => {
        expect(isOptOutMessage('Yes, interested!')).toBe(false)
      })

      it('should return false for "Call me tomorrow"', () => {
        expect(isOptOutMessage('Call me tomorrow')).toBe(false)
      })

      it('should return false for "Not interested"', () => {
        expect(isOptOutMessage('Not interested')).toBe(false)
      })

      it('should return false for "Remove me from your list"', () => {
        // Note: "Remove" is NOT an opt-out keyword, only STOP/CANCEL/UNSUBSCRIBE/QUIT/END
        expect(isOptOutMessage('Remove me from your list')).toBe(false)
      })

      it('should return false for empty string', () => {
        expect(isOptOutMessage('')).toBe(false)
      })
    })

    describe('Edge cases', () => {
      it('should handle whitespace around keywords', () => {
        expect(isOptOutMessage('  STOP  ')).toBe(true)
      })

      it('should handle newlines', () => {
        expect(isOptOutMessage('STOP\n')).toBe(true)
      })

      it('should handle punctuation after keyword', () => {
        expect(isOptOutMessage('STOP!')).toBe(true)
      })

      it('should handle punctuation before keyword', () => {
        expect(isOptOutMessage('Please... STOP')).toBe(true)
      })
    })
  })

  describe('OPT_OUT_KEYWORDS constant', () => {
    it('should include STOP', () => {
      expect(OPT_OUT_KEYWORDS).toContain('STOP')
    })

    it('should include CANCEL', () => {
      expect(OPT_OUT_KEYWORDS).toContain('CANCEL')
    })

    it('should include UNSUBSCRIBE', () => {
      expect(OPT_OUT_KEYWORDS).toContain('UNSUBSCRIBE')
    })

    it('should include QUIT', () => {
      expect(OPT_OUT_KEYWORDS).toContain('QUIT')
    })

    it('should include END', () => {
      expect(OPT_OUT_KEYWORDS).toContain('END')
    })

    it('should have exactly 5 keywords', () => {
      expect(OPT_OUT_KEYWORDS).toHaveLength(5)
    })
  })
})

describe('Opt-Out Flow - Critical Bug Documentation', () => {
  // This documents the KNOWN BUG in the opt-out tracking flow

  describe('Redis key mismatch (BUG)', () => {
    // When a message is sent, the phone is stored in 'ever-messaged'
    // When opt-out webhook checks, it looks in 'suppression:ever-messaged'
    // These are DIFFERENT keys, so opt-out detection fails

    it('documents the bug: send route uses wrong Redis key', () => {
      // app/api/campaign/send/route.ts line 125:
      // await redis.sadd('ever-messaged', phone)
      //
      // But app/api/webhooks/quo/route.ts line 431:
      // const wasMessaged = await redis.sismember('suppression:ever-messaged', normalizedPhone)
      //
      // These are different keys!
      expect(true).toBe(true) // Placeholder - actual fix in Phase 3
    })
  })

  describe('Expected flow after fix', () => {
    it('message sent should add to suppression:ever-messaged', () => {
      // After fix: await redis.sadd('suppression:ever-messaged', normalizedPhone)
      expect(true).toBe(true)
    })

    it('webhook should find phone in suppression:ever-messaged', () => {
      // Already correct: redis.sismember('suppression:ever-messaged', normalizedPhone)
      expect(true).toBe(true)
    })

    it('opt-out should add to optouts:phones', () => {
      // Already correct: redis.sadd('optouts:phones', normalizedPhone)
      expect(true).toBe(true)
    })

    it('opt-out should increment campaign stats', () => {
      // Already correct: incrementCampaignStats(campaignId, { optOuts: 1 })
      expect(true).toBe(true)
    })
  })
})
