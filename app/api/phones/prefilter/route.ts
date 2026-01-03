import { NextRequest } from 'next/server'
import { checkSuppression, checkManyEverMessaged } from '@/app/lib/suppression'
import { checkManyConversations } from '@/app/lib/openphone'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

interface PrefilterRequest {
  phones: Array<{
    id: string
    phone: string
  }>
  skipOpenPhoneCheck?: boolean
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
          previousCampaign: 0,
          openphoneHistory: 0,
        }

        // PHASE 1: Suppression check
        send('progress', {
          phase: 1,
          total: 4,
          message: 'Checking suppression lists...',
          detail: `Checking ${validPhones.length} phones against opt-outs, DNC, and litigator lists`,
        })

        let afterSuppression: Array<{ id: string; phone: string }> = []
        for (const phone of validPhones) {
          const reason = await checkSuppression(phone.phone)
          if (reason) {
            removed[reason]++
          } else {
            afterSuppression.push(phone)
          }
        }

        send('progress', {
          phase: 1,
          total: 4,
          message: 'Suppression check complete',
          detail: `Removed ${removed.optout + removed.dnc + removed.litigator} (${removed.optout} opt-outs, ${removed.dnc} DNC, ${removed.litigator} litigators)`,
          remaining: afterSuppression.length,
        })

        // PHASE 2: Ever-messaged check
        send('progress', {
          phase: 2,
          total: 4,
          message: 'Checking previous campaigns...',
          detail: `Checking ${afterSuppression.length} phones against campaign history`,
        })

        const phoneNumbers = afterSuppression.map(p => p.phone)
        const everMessaged = await checkManyEverMessaged(phoneNumbers)

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
        const totalRemoved = Object.values(removed).reduce((a, b) => a + b, 0)
        const preFilterStats = {
          original: validPhones.length,
          removed,
          remaining: afterOpenPhone.length,
        }

        send('complete', {
          phase: 4,
          total: 4,
          message: 'Pre-filtering complete',
          preFilterStats,
          preFilteredPhones: afterOpenPhone,
          totalRemoved,
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
