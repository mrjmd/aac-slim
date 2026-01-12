/**
 * Manual batch trigger endpoint (NO QStash verification)
 * USE WITH CAUTION - only for manual intervention when QStash scheduling fails
 *
 * Requires API_SECRET header for basic auth protection
 */

import { NextResponse } from 'next/server'
import { Redis } from '@upstash/redis'
import { Client } from '@upstash/qstash'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

function getRedis() {
  const url = process.env.UPSTASH_REDIS_REST_URL
  const token = process.env.UPSTASH_REDIS_REST_TOKEN
  if (!url || !token) throw new Error('Redis not configured')
  return new Redis({ url, token })
}

function getQstash() {
  const token = process.env.QSTASH_TOKEN
  if (!token) throw new Error('QStash not configured')
  return new Client({ token })
}

interface NormalizedContact {
  firstName: string
  lastName: string | null
  phone: string
  email: string | null
  city: string
  subdivision: string | null
  address: string | null
  zip: string | null
}

function personalizeMessage(template: string, contact: NormalizedContact): string {
  return template
    .replace(/\{firstName\}/g, contact.firstName)
    .replace(/\{lastName\}/g, contact.lastName || '')
    .replace(/\{city\}/g, contact.city)
    .replace(/\{neighborhood\}/g, contact.subdivision || contact.city)
}

async function createPipedriveContact(contact: NormalizedContact, _campaignName: string): Promise<{ id: number; created: boolean }> {
  const apiKey = process.env.PIPEDRIVE_API_KEY
  const domain = process.env.PIPEDRIVE_COMPANY_DOMAIN

  const searchRes = await fetch(
    `https://${domain}.pipedrive.com/api/v1/persons/search?term=${encodeURIComponent(contact.phone)}&fields=phone&api_token=${apiKey}`
  )
  const searchData = await searchRes.json()

  if (searchData.data?.items?.length > 0) {
    return { id: searchData.data.items[0].item.id, created: false }
  }

  const createRes = await fetch(
    `https://${domain}.pipedrive.com/api/v1/persons?api_token=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: `${contact.firstName} ${contact.lastName || ''}`.trim(),
        phone: [{ value: contact.phone, primary: true, label: 'mobile' }],
        email: contact.email ? [{ value: contact.email, primary: true, label: 'work' }] : undefined,
        visible_to: 3,
      }),
    }
  )
  const createData = await createRes.json()
  return { id: createData.data.id, created: true }
}

function calculateNextBatchTime(startHour: number, skipWeekends: boolean): Date {
  const next = new Date()
  next.setDate(next.getDate() + 1)
  next.setHours(startHour, 0, 0, 0)

  if (skipWeekends) {
    while (next.getDay() === 0 || next.getDay() === 6) {
      next.setDate(next.getDate() + 1)
    }
  }

  return next
}

export async function POST(request: Request) {
  try {
    // Basic auth check - require API secret
    const authHeader = request.headers.get('x-api-secret')
    const expectedSecret = process.env.API_SECRET || process.env.QSTASH_CURRENT_SIGNING_KEY

    if (!authHeader || authHeader !== expectedSecret) {
      return NextResponse.json({ error: 'Unauthorized - provide x-api-secret header' }, { status: 401 })
    }

    const redis = getRedis()
    const qstash = getQstash()

    const body = await request.json()
    const { campaignId, optOutFooter = 'Reply STOP to unsubscribe', throttleSeconds = 5 } = body

    if (!campaignId) {
      return NextResponse.json({ error: 'campaignId required' }, { status: 400 })
    }

    // Get campaign data
    const campaignRaw = await redis.get(`campaign:${campaignId}`)
    if (!campaignRaw) {
      return NextResponse.json({ error: 'Campaign not found' }, { status: 404 })
    }

    const campaign = typeof campaignRaw === 'string' ? JSON.parse(campaignRaw) : campaignRaw
    if (!campaign.multiDay) {
      return NextResponse.json({ error: 'Not a multi-day campaign' }, { status: 400 })
    }

    // Get pending contacts
    const pendingKey = `campaign:${campaignId}:pending`
    const pendingRaw = await redis.get(pendingKey)
    if (!pendingRaw) {
      return NextResponse.json({
        success: true,
        complete: true,
        message: 'No pending contacts - all batches already sent',
      })
    }

    const allContacts: NormalizedContact[] = typeof pendingRaw === 'string' ? JSON.parse(pendingRaw) : pendingRaw
    const batchSize = campaign.multiDay.dailyLimit
    const batch = allContacts.slice(0, batchSize)
    const remaining = allContacts.slice(batchSize)

    // Update pending contacts
    if (remaining.length > 0) {
      await redis.set(pendingKey, JSON.stringify(remaining))
    } else {
      await redis.del(pendingKey)
    }

    // Process the batch
    const callbackUrl = 'https://aac-middleware.vercel.app/api/campaign/send'
    const batchCallbackUrl = 'https://aac-middleware.vercel.app/api/campaign/process-batch'

    let queueIndex = 0
    let queued = 0
    let pipedriveCreated = 0

    for (const contact of batch) {
      let messageTemplate = campaign.messageTemplate
      let variantId: string | undefined

      if (campaign.variants && campaign.variants.length > 0) {
        const randomVariant = campaign.variants[Math.random() < 0.5 ? 0 : 1]
        messageTemplate = randomVariant.message
        variantId = randomVariant.id
      }

      let personalizedMessage = personalizeMessage(messageTemplate, contact)
      if (optOutFooter) {
        personalizedMessage = `${personalizedMessage}\n\n${optOutFooter}`
      }

      // Create Pipedrive contact
      const { id: personId, created } = await createPipedriveContact(contact, campaign.name)
      if (created) pipedriveCreated++

      // Queue message via QStash
      const delay = Math.floor(queueIndex * throttleSeconds)
      await qstash.publishJSON({
        url: callbackUrl,
        delay,
        body: {
          campaignId,
          pipedrivePersonId: personId,
          phone: contact.phone,
          message: personalizedMessage,
          variant: variantId,
        },
      })

      campaign.stats.queued = (campaign.stats.queued || 0) + 1
      queued++
      queueIndex++
    }

    // Update campaign day count
    campaign.multiDay.currentDay = (campaign.multiDay.currentDay || 1) + 1

    // Schedule next batch if there are more contacts
    if (remaining.length > 0) {
      const nextTime = calculateNextBatchTime(campaign.multiDay.startHour, campaign.multiDay.skipWeekends)
      const delaySeconds = Math.max(0, Math.floor((nextTime.getTime() - Date.now()) / 1000))

      await qstash.publishJSON({
        url: batchCallbackUrl,
        delay: delaySeconds,
        body: {
          campaignId,
          optOutFooter,
          throttleSeconds,
        },
      })

      campaign.multiDay.nextBatchAt = nextTime.toISOString()
    } else {
      campaign.multiDay.nextBatchAt = null
    }

    await redis.set(`campaign:${campaignId}`, JSON.stringify(campaign))

    return NextResponse.json({
      success: true,
      day: campaign.multiDay.currentDay,
      queued,
      pipedriveCreated,
      remaining: remaining.length,
      nextBatchAt: campaign.multiDay.nextBatchAt,
      message: `Batch triggered manually. ${queued} messages queued.`,
    })
  } catch (error) {
    console.error('Manual batch trigger error:', error)
    return NextResponse.json({ error: (error as Error).message }, { status: 500 })
  }
}
