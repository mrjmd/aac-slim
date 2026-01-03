import { NextResponse } from 'next/server'
import { Redis } from '@upstash/redis'
import { Client } from '@upstash/qstash'
import { verifySignatureAppRouter } from '@upstash/qstash/nextjs'

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

interface BatchRequest {
  campaignId: string
  optOutFooter: string
  throttleSeconds: number
  skipDedup: boolean
}

function personalizeMessage(template: string, contact: NormalizedContact): string {
  return template
    .replace(/\{firstName\}/g, contact.firstName)
    .replace(/\{lastName\}/g, contact.lastName || '')
    .replace(/\{city\}/g, contact.city)
    .replace(/\{neighborhood\}/g, contact.subdivision || contact.city)
}

async function hasExistingConversation(phone: string): Promise<boolean> {
  const apiKey = process.env.QUO_API_KEY
  if (!apiKey) return false
  try {
    const res = await fetch(
      `https://api.openphone.com/v1/conversations?participants=${encodeURIComponent(phone)}&maxResults=1`,
      { headers: { Authorization: apiKey } }
    )
    if (!res.ok) return false
    const data = await res.json()
    return data.data && data.data.length > 0
  } catch {
    return false
  }
}

async function createPipedriveContact(contact: NormalizedContact, campaignName: string): Promise<{ id: number; created: boolean }> {
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
        '9c5cc1715fdd7b997dbd81a09c75f2c399f29dee': `Campaign: ${campaignName}`,
      }),
    }
  )
  const createData = await createRes.json()
  return { id: createData.data.id, created: true }
}

// Calculate next batch time (tomorrow at start hour, skipping weekends if configured)
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

async function handler(request: Request) {
  try {
    const redis = getRedis()
    const qstash = getQstash()

    const body: BatchRequest = await request.json()
    const { campaignId, optOutFooter, throttleSeconds, skipDedup } = body

    // Get campaign data
    const campaignRaw = await redis.get(`campaign:${campaignId}`) as string | null
    if (!campaignRaw) {
      return NextResponse.json({ error: 'Campaign not found' }, { status: 404 })
    }

    const campaign = JSON.parse(campaignRaw)
    if (!campaign.multiDay) {
      return NextResponse.json({ error: 'Not a multi-day campaign' }, { status: 400 })
    }

    // Check if today is a weekend and should skip
    const today = new Date()
    const isWeekend = today.getDay() === 0 || today.getDay() === 6
    if (campaign.multiDay.skipWeekends && isWeekend) {
      // Reschedule for next valid day
      const nextTime = calculateNextBatchTime(campaign.multiDay.startHour, true)
      const delaySeconds = Math.max(0, Math.floor((nextTime.getTime() - Date.now()) / 1000))

      await qstash.publishJSON({
        url: request.url,
        delay: delaySeconds,
        body,
      })

      // Update campaign with new next batch time
      campaign.multiDay.nextBatchAt = nextTime.toISOString()
      await redis.set(`campaign:${campaignId}`, JSON.stringify(campaign))

      return NextResponse.json({
        success: true,
        skippedWeekend: true,
        nextBatchAt: nextTime.toISOString(),
      })
    }

    // Get next batch of contacts
    const pendingKey = `campaign:${campaignId}:pending`
    const pendingRaw = await redis.get(pendingKey) as string | null
    if (!pendingRaw) {
      // No more contacts - campaign complete
      campaign.status = 'completed'
      campaign.multiDay.nextBatchAt = null
      await redis.set(`campaign:${campaignId}`, JSON.stringify(campaign))

      return NextResponse.json({
        success: true,
        complete: true,
        message: 'Campaign completed - no more contacts',
      })
    }

    const allContacts: NormalizedContact[] = JSON.parse(pendingRaw)
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
    const callbackUrl = `${process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'https://aac-middleware.vercel.app'}/api/campaign/send`

    let queueIndex = 0
    let queued = 0
    let skipped = 0
    let pipedriveCreated = 0

    for (const contact of batch) {
      // Dedup check
      if (!skipDedup) {
        const hasConversation = await hasExistingConversation(contact.phone)
        if (hasConversation) {
          skipped++
          // Increment skipped stat
          campaign.stats.skipped = (campaign.stats.skipped || 0) + 1
          continue
        }
      }

      // Select variant if A/B test
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

      // Queue message
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
        url: request.url,
        delay: delaySeconds,
        body,
      })

      campaign.multiDay.nextBatchAt = nextTime.toISOString()
    } else {
      // Last batch - mark for completion once messages are sent
      campaign.multiDay.nextBatchAt = null
    }

    await redis.set(`campaign:${campaignId}`, JSON.stringify(campaign))

    return NextResponse.json({
      success: true,
      day: campaign.multiDay.currentDay,
      queued,
      skipped,
      pipedriveCreated,
      remaining: remaining.length,
      nextBatchAt: campaign.multiDay.nextBatchAt,
    })
  } catch (error) {
    console.error('Batch process error:', error)
    return NextResponse.json({ error: (error as Error).message }, { status: 500 })
  }
}

// Verify QStash signature
export const POST = verifySignatureAppRouter(handler)
