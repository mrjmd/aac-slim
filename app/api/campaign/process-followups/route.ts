import { NextResponse } from 'next/server'
import { Redis } from '@upstash/redis'
import { Client } from '@upstash/qstash'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

function getRedis() {
  const url = process.env.UPSTASH_REDIS_REST_URL
  const token = process.env.UPSTASH_REDIS_REST_TOKEN
  if (!url || !token) {
    throw new Error('Redis environment variables not configured')
  }
  return new Redis({ url, token })
}

function getQstash() {
  const token = process.env.QSTASH_TOKEN
  if (!token) {
    throw new Error('QStash token not configured')
  }
  return new Client({ token })
}

interface Recipient {
  phone: string
  firstName: string
  lastName: string | null
  city: string
  subdivision: string | null
  sentAt: string
  responded: boolean
  variant?: string
  followUpSent?: boolean
}

interface FollowUpConfig {
  delayDays: number
  message: string
  sent: number
}

interface Campaign {
  id: string
  name: string
  status: string
  followUp?: FollowUpConfig
}

// Normalize to title case: "QUINCY" -> "Quincy", "south boston" -> "South Boston"
function toTitleCase(str: string): string {
  if (!str) return ''
  return str
    .toLowerCase()
    .split(' ')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}

function personalizeMessage(
  template: string,
  recipient: Recipient
): string {
  return template
    .replace(/\{firstName\}/g, toTitleCase(recipient.firstName))
    .replace(/\{lastName\}/g, toTitleCase(recipient.lastName || ''))
    .replace(/\{city\}/g, toTitleCase(recipient.city))
    .replace(/\{neighborhood\}/g, toTitleCase(recipient.subdivision || recipient.city))
}

// Verify QStash signature for cron security
function verifyQstashSignature(request: Request): boolean {
  const signature = request.headers.get('upstash-signature')
  // In development, allow without signature
  if (process.env.NODE_ENV === 'development' && !signature) {
    return true
  }
  // QStash will include signature header when calling this endpoint
  // For now, just check signature exists (proper verification needs qstash SDK)
  return !!signature
}

export async function POST(request: Request) {
  try {
    // Verify this is a legitimate QStash cron call
    if (!verifyQstashSignature(request)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const redis = getRedis()
    const qstash = getQstash()

    // Fetch global settings for opt-out footer and throttle
    const settingsData = await redis.get('settings:global')
    const settings = settingsData
      ? typeof settingsData === 'string' ? JSON.parse(settingsData) : settingsData
      : { campaign: { optOutFooter: '', throttleSeconds: 2.5 } }
    const optOutFooter = settings.campaign?.optOutFooter || ''
    const throttleSeconds = settings.campaign?.throttleSeconds || 2.5

    // Get all active campaigns
    const campaignIds = await redis.smembers('campaigns:active') as string[]

    const results = {
      processed: 0,
      followUpsSent: 0,
      campaignsChecked: 0,
      errors: [] as string[],
    }

    // Always use production URL for consistent signature verification
    const callbackUrl = 'https://aac-middleware.vercel.app/api/campaign/send'

    for (const campaignId of campaignIds) {
      try {
        const campaignData = await redis.get(`campaign:${campaignId}`)
        if (!campaignData) continue

        const campaign = typeof campaignData === 'string'
          ? JSON.parse(campaignData) as Campaign
          : campaignData as Campaign

        // Skip campaigns without follow-up configured
        if (!campaign.followUp) continue

        // Skip paused campaigns
        if (campaign.status === 'paused') continue

        results.campaignsChecked++

        const delayMs = campaign.followUp.delayDays * 24 * 60 * 60 * 1000
        const cutoffTime = new Date(Date.now() - delayMs)

        // Get all recipients for this campaign
        const recipientsData = await redis.hgetall(`campaign:${campaignId}:recipients`) as Record<string, string> | null
        if (!recipientsData) continue

        let queueIndex = 0

        for (const [phone, recipientRaw] of Object.entries(recipientsData)) {
          // Handle both string (manual JSON.stringify) and object (Upstash auto-deserialize)
          const recipient = (typeof recipientRaw === 'string' ? JSON.parse(recipientRaw) : recipientRaw) as Recipient

          // Skip if already responded
          if (recipient.responded) continue

          // Skip if follow-up already sent
          if (recipient.followUpSent) continue

          // Check if enough time has passed since initial message
          const sentAt = new Date(recipient.sentAt)
          if (sentAt > cutoffTime) continue

          results.processed++

          // Personalize follow-up message
          let followUpMessage = personalizeMessage(campaign.followUp.message, recipient)

          // Append opt-out footer if configured
          if (optOutFooter) {
            followUpMessage = `${followUpMessage}\n\n${optOutFooter}`
          }

          // Queue follow-up message via QStash
          const delay = Math.floor(queueIndex * throttleSeconds)
          await qstash.publishJSON({
            url: callbackUrl,
            delay,
            body: {
              campaignId,
              phone: recipient.phone,
              message: followUpMessage,
              isFollowUp: true,
              variant: recipient.variant,
            },
          })

          // Mark as follow-up sent
          recipient.followUpSent = true
          await redis.hset(`campaign:${campaignId}:recipients`, { [phone]: JSON.stringify(recipient) })

          // Update campaign follow-up stats
          const updatedCampaignData = await redis.get(`campaign:${campaignId}`)
          if (updatedCampaignData) {
            const updatedCampaign = typeof updatedCampaignData === 'string'
              ? JSON.parse(updatedCampaignData)
              : updatedCampaignData
            if (updatedCampaign.followUp) {
              updatedCampaign.followUp.sent = (updatedCampaign.followUp.sent || 0) + 1
              await redis.set(`campaign:${campaignId}`, JSON.stringify(updatedCampaign))
            }
          }

          results.followUpsSent++
          queueIndex++
        }
      } catch (err) {
        results.errors.push(`Campaign ${campaignId}: ${(err as Error).message}`)
      }
    }

    console.log('Follow-up processing complete:', results)

    return NextResponse.json({
      success: true,
      ...results,
    })
  } catch (error) {
    console.error('Follow-up processing error:', error)
    return NextResponse.json({ error: (error as Error).message }, { status: 500 })
  }
}

// Also support GET for manual testing
export async function GET(request: Request) {
  // For manual testing, just call POST handler
  return POST(request)
}
