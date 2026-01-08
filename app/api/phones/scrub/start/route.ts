import { NextResponse } from 'next/server'
import { Redis } from '@upstash/redis'
import { submitPhoneBatch } from '@/src/clients/searchbug'
import { checkSuppression, checkManyEverMessaged } from '@/app/lib/suppression'
import { checkManyConversations } from '@/app/lib/openphone'

function getRedis() {
  const url = process.env.UPSTASH_REDIS_REST_URL
  const token = process.env.UPSTASH_REDIS_REST_TOKEN
  if (!url || !token) {
    throw new Error('Redis environment variables not configured')
  }
  return new Redis({ url, token })
}

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

// SearchBug bulk API handles large batches well
// We submit all at once since their async processing handles it
const MAX_PHONES_PER_BATCH = 5000 // Safety limit

interface ScrubStartRequest {
  phones: Array<{
    id: string
    phone: string
  }>
  // Optional: skip OpenPhone check if we know these are fresh leads
  skipOpenPhoneCheck?: boolean
  // Optional: use these pre-filtered phones instead of running OpenPhone check again
  // This is used for retries after SearchBug fails
  preFilteredPhones?: Array<{
    id: string
    phone: string
  }>
  // Stats from previous pre-filter run (for display)
  previousPreFilterStats?: PreFilterStats
  // Include DNC numbers (don't filter them out)
  includeDnc?: boolean
}

interface PreFilteredPhone {
  id: string
  phone: string
}

// All the reasons a phone can be removed before SearchBug
export interface PreFilterStats {
  original: number
  removed: {
    optout: number         // From our opt-out list
    dnc: number            // From previous SearchBug scrubs
    litigator: number      // From previous SearchBug scrubs
    previousCampaign: number  // Already messaged in a previous campaign
    openphoneHistory: number  // Has existing conversation in OpenPhone
  }
  remaining: number
}

export async function POST(request: Request) {
  try {
    const body: ScrubStartRequest = await request.json()

    // If we have pre-filtered phones from a previous run, skip straight to SearchBug
    if (body.preFilteredPhones && body.preFilteredPhones.length > 0) {
      console.log(`Using ${body.preFilteredPhones.length} pre-filtered phones (skipping OpenPhone check)`)
      console.log(`includeDnc setting: ${body.includeDnc}`)

      const { key, estimatedMinutes } = await submitPhoneBatch(body.preFilteredPhones)

      // Store includeDnc setting with the key (expires in 1 hour)
      // CRITICAL: This must happen for status route to respect the setting
      if (body.includeDnc) {
        const redis = getRedis()
        await redis.set(`scrub:settings:${key}`, JSON.stringify({ includeDnc: true }), { ex: 3600 })
        console.log(`Stored includeDnc=true for key ${key}`)
      }

      return NextResponse.json({
        success: true,
        key,
        count: body.preFilteredPhones.length,
        estimatedMinutes,
        preFiltered: body.previousPreFilterStats,
        skippedPreFilter: true,
        message: `Using cached pre-filter results. Sending ${body.preFilteredPhones.length} to SearchBug.`,
      })
    }

    if (!body.phones || !Array.isArray(body.phones) || body.phones.length === 0) {
      return NextResponse.json(
        { error: 'phones array is required' },
        { status: 400 }
      )
    }

    // Validate phone format
    const validPhones = body.phones.filter(p => p.id && p.phone)
    if (validPhones.length === 0) {
      return NextResponse.json(
        { error: 'No valid phones provided (each needs id and phone)' },
        { status: 400 }
      )
    }

    if (validPhones.length > MAX_PHONES_PER_BATCH) {
      return NextResponse.json(
        { error: `Too many phones (${validPhones.length}). Maximum is ${MAX_PHONES_PER_BATCH} per batch.` },
        { status: 400 }
      )
    }

    // Initialize removal stats
    const removed = {
      optout: 0,
      dnc: 0,
      litigator: 0,
      landline: 0,
      previousCampaign: 0,
      openphoneHistory: 0,
    }

    // PHASE 1: Check internal suppression lists (instant, free)
    // This includes opt-outs, DNC from previous scrubs, and litigators
    let afterSuppression: PreFilteredPhone[] = []
    for (const phone of validPhones) {
      const reason = await checkSuppression(phone.phone)
      if (reason) {
        removed[reason]++
      } else {
        afterSuppression.push(phone)
      }
    }

    // PHASE 2: Check "ever messaged" list (instant, free)
    // These are phones we've sent to in any previous campaign
    const phoneNumbers = afterSuppression.map(p => p.phone)
    const everMessaged = await checkManyEverMessaged(phoneNumbers)

    let afterEverMessaged: PreFilteredPhone[] = []
    for (const phone of afterSuppression) {
      if (everMessaged.has(phone.phone)) {
        removed.previousCampaign++
      } else {
        afterEverMessaged.push(phone)
      }
    }

    // PHASE 3: Check OpenPhone conversation history (free API, but slower)
    // Skip only if explicitly disabled or no phones left
    let afterOpenPhone: PreFilteredPhone[] = afterEverMessaged

    if (!body.skipOpenPhoneCheck && afterEverMessaged.length > 0) {
      try {
        const phonesToCheck = afterEverMessaged.map(p => p.phone)
        const result = await checkManyConversations(phonesToCheck, {
          concurrency: 2,  // Very conservative to avoid rate limits
          delayMs: 500,    // 500ms between batches
        })

        if (result.errorCount > 0) {
          console.warn(`OpenPhone check had ${result.errorCount} API errors`)
        }

        afterOpenPhone = []
        for (const phone of afterEverMessaged) {
          if (result.hasConversation.has(phone.phone)) {
            removed.openphoneHistory++
          } else {
            afterOpenPhone.push(phone)
          }
        }
      } catch (error) {
        // If OpenPhone check fails, continue with what we have
        console.error('OpenPhone check failed, continuing without it:', error)
        afterOpenPhone = afterEverMessaged
      }
    }

    const totalRemoved = Object.values(removed).reduce((a, b) => a + b, 0)
    const preFilterStats: PreFilterStats = {
      original: validPhones.length,
      removed,
      remaining: afterOpenPhone.length,
    }

    // If all phones were pre-filtered, return early (no SearchBug call needed!)
    if (afterOpenPhone.length === 0) {
      return NextResponse.json({
        success: true,
        key: null, // No SearchBug call needed
        count: 0,
        estimatedMinutes: 0,
        preFiltered: preFilterStats,
        message: `All ${validPhones.length} phones were already in our system`,
      })
    }

    // Submit remaining phones to SearchBug bulk API
    const { key, estimatedMinutes } = await submitPhoneBatch(afterOpenPhone)

    // Store includeDnc setting with the key (expires in 1 hour)
    if (body.includeDnc) {
      const redis = getRedis()
      await redis.set(`scrub:settings:${key}`, JSON.stringify({ includeDnc: true }), { ex: 3600 })
    }

    // Build message
    let message = ''
    if (totalRemoved > 0) {
      message = `Pre-filtered ${totalRemoved} phones. `
    }
    message += `Sending ${afterOpenPhone.length} to SearchBug for validation.`

    return NextResponse.json({
      success: true,
      key,
      count: afterOpenPhone.length,
      estimatedMinutes,
      preFiltered: totalRemoved > 0 ? preFilterStats : undefined,
      // Return the pre-filtered phones so frontend can cache them for retries
      preFilteredPhones: afterOpenPhone,
      message: message.trim(),
    })
  } catch (error) {
    console.error('Phone scrub start error:', error)
    return NextResponse.json(
      { error: (error as Error).message },
      { status: 500 }
    )
  }
}
