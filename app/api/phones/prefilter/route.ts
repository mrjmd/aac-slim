import { NextRequest } from 'next/server'
import { batchCheckCache, checkManyEverMessaged } from '@/app/lib/suppression'
import { checkManyConversations } from '@/app/lib/openphone'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

interface PrefilterRequest {
  phones: Array<{
    id: string
    phone: string
  }>
  skipOpenPhoneCheck?: boolean
  includeDnc?: boolean // Include DNC numbers (don't filter them out)
}

/**
 * Streaming pre-filter endpoint
 * Returns Server-Sent Events with progress updates
 */
export async function POST(request: NextRequest) {
  const body: PrefilterRequest = await request.json()

  if (!body.phones || !Array.isArray(body.phones) || body.phones.length === 0) {
    return new Response(JSON.stringify({ error: 'phones array is required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const validPhones = body.phones.filter(p => p.id && p.phone)

  // Create a streaming response
  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`))
      }

      try {
        const removed = {
          optout: 0,
          dnc: 0,
          litigator: 0,
          landline: 0,
          inactive: 0,
          previousCampaign: 0,
          openphoneHistory: 0,
        }

        // PHASE 1: Check all caches (suppression lists + verified clean/inactive)
        console.log('Prefilter received includeDnc:', body.includeDnc)
        send('progress', {
          phase: 1,
          total: 4,
          message: 'Checking caches...',
          detail: `Checking ${validPhones.length} phones against suppression lists and verification cache${body.includeDnc ? ' (DNC included)' : ''}`,
        })

        const phoneNumbers = validPhones.map(p => p.phone)
        const cacheResults = await batchCheckCache(phoneNumbers)

        // Track removed phones and verified clean phones
        let afterSuppression: Array<{ id: string; phone: string }> = []
        let verifiedCleanPhones: Array<{ id: string; phone: string }> = []

        for (const phone of validPhones) {
          const suppressedReason = cacheResults.suppressed.get(phone.phone)
          if (suppressedReason) {
            // When includeDnc is enabled, treat cached DNC phones as verified clean (skip SearchBug)
            if (suppressedReason === 'dnc' && body.includeDnc) {
              verifiedCleanPhones.push(phone)
              continue
            }
            if (suppressedReason === 'optout') removed.optout++
            else if (suppressedReason === 'dnc') removed.dnc++
            else if (suppressedReason === 'litigator') removed.litigator++
            else if (suppressedReason === 'landline') removed.landline++
            else if (suppressedReason === 'inactive') removed.inactive++
          } else if (cacheResults.verifiedClean.has(phone.phone)) {
            // Already verified clean - skip SearchBug but include in final list
            verifiedCleanPhones.push(phone)
          } else {
            afterSuppression.push(phone)
          }
        }

        const totalSuppressed = removed.optout + removed.dnc + removed.litigator + removed.landline + removed.inactive
        send('progress', {
          phase: 1,
          total: 4,
          message: 'Cache check complete',
          detail: `Removed ${totalSuppressed} suppressed, ${verifiedCleanPhones.length} already verified clean, ${afterSuppression.length} need validation`,
          remaining: afterSuppression.length,
          verifiedClean: verifiedCleanPhones.length,
        })

        // PHASE 2: Ever-messaged check
        send('progress', {
          phase: 2,
          total: 4,
          message: 'Checking previous campaigns...',
          detail: `Checking ${afterSuppression.length} phones against campaign history`,
        })

        const phonesToCheckHistory = afterSuppression.map(p => p.phone)
        const everMessaged = await checkManyEverMessaged(phonesToCheckHistory)

        let afterEverMessaged: Array<{ id: string; phone: string }> = []
        for (const phone of afterSuppression) {
          if (everMessaged.has(phone.phone)) {
            removed.previousCampaign++
          } else {
            afterEverMessaged.push(phone)
          }
        }

        send('progress', {
          phase: 2,
          total: 4,
          message: 'Campaign history check complete',
          detail: `Removed ${removed.previousCampaign} previously messaged`,
          remaining: afterEverMessaged.length,
        })

        // PHASE 3: OpenPhone check
        let afterOpenPhone = afterEverMessaged
        if (!body.skipOpenPhoneCheck && afterEverMessaged.length > 0) {
          send('progress', {
            phase: 3,
            total: 4,
            message: 'Checking OpenPhone history...',
            detail: `Checking ${afterEverMessaged.length} phones for existing conversations (this may take a minute)`,
          })

          try {
            const phonesToCheck = afterEverMessaged.map(p => p.phone)
            let checked = 0
            const hasConversation = new Set<string>()

            // Check in small batches and report progress
            const batchSize = 10
            for (let i = 0; i < phonesToCheck.length; i += batchSize) {
              const batch = phonesToCheck.slice(i, i + batchSize)
              const batchResults = await checkManyConversations(batch, {
                concurrency: 2,
                delayMs: 300,
              })

              for (const phone of batchResults) {
                hasConversation.add(phone)
              }

              checked += batch.length
              send('progress', {
                phase: 3,
                total: 4,
                message: `Checking OpenPhone history... ${checked}/${phonesToCheck.length}`,
                detail: `Found ${hasConversation.size} with existing conversations`,
                checked,
                totalToCheck: phonesToCheck.length,
              })
            }

            afterOpenPhone = []
            for (const phone of afterEverMessaged) {
              if (hasConversation.has(phone.phone)) {
                removed.openphoneHistory++
              } else {
                afterOpenPhone.push(phone)
              }
            }

            send('progress', {
              phase: 3,
              total: 4,
              message: 'OpenPhone check complete',
              detail: `Removed ${removed.openphoneHistory} with existing conversations`,
              remaining: afterOpenPhone.length,
            })
          } catch (error) {
            send('progress', {
              phase: 3,
              total: 4,
              message: 'OpenPhone check failed (continuing without it)',
              detail: (error as Error).message,
              remaining: afterEverMessaged.length,
            })
            afterOpenPhone = afterEverMessaged
          }
        } else {
          send('progress', {
            phase: 3,
            total: 4,
            message: 'OpenPhone check skipped',
            detail: body.skipOpenPhoneCheck ? 'Skipped by request' : 'No phones to check',
            remaining: afterOpenPhone.length,
          })
        }

        // PHASE 4: Complete
        // Combine verified clean (from cache) + phones that passed all checks (need SearchBug)
        const totalRemoved = Object.values(removed).reduce((a, b) => a + b, 0)
        const preFilterStats = {
          original: validPhones.length,
          removed,
          remaining: afterOpenPhone.length,
          verifiedCleanFromCache: verifiedCleanPhones.length,
        }

        send('complete', {
          phase: 4,
          total: 4,
          message: 'Pre-filtering complete',
          preFilterStats,
          // Phones that need SearchBug validation
          preFilteredPhones: afterOpenPhone,
          // Phones already verified clean (skip SearchBug)
          verifiedCleanPhones: verifiedCleanPhones,
          totalRemoved,
          // Pass through settings for scrub
          includeDnc: body.includeDnc || false,
        })

        controller.close()
      } catch (error) {
        send('error', {
          message: (error as Error).message,
        })
        controller.close()
      }
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  })
}
