/**
 * Campaign Send Endpoint (App Router)
 *
 * Called by QStash with delayed message payloads.
 * Verifies signature, checks opt-outs, sends SMS, updates stats.
 */

import { NextResponse } from 'next/server'
import { verifySignatureAppRouter } from '@upstash/qstash/nextjs'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

interface SendPayload {
  campaignId: string
  pipedrivePersonId: number
  phone: string
  message: string
  variant?: string
}

// Environment helpers
function getQuoConfig() {
  const apiKey = process.env.QUO_API_KEY
  const phoneNumber = process.env.QUO_PHONE_NUMBER
  if (!apiKey || !phoneNumber) {
    throw new Error('Quo/OpenPhone not configured')
  }
  return { apiKey, phoneNumber }
}

function getRedis() {
  const { Redis } = require('@upstash/redis')
  const url = process.env.UPSTASH_REDIS_REST_URL
  const token = process.env.UPSTASH_REDIS_REST_TOKEN
  if (!url || !token) throw new Error('Redis not configured')
  return new Redis({ url, token })
}

// Send message via OpenPhone
async function sendMessage(from: string, to: string, text: string) {
  const { apiKey } = getQuoConfig()

  const response = await fetch('https://api.openphone.com/v1/messages', {
    method: 'POST',
    headers: {
      'Authorization': apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from,
      to: [to],
      text,
    }),
  })

  if (!response.ok) {
    const error = await response.text()
    throw new Error(`OpenPhone API error: ${response.status} - ${error}`)
  }

  const data = await response.json()
  return { id: data.data?.id || 'unknown' }
}

// Check if phone is opted out
async function isOptedOut(phone: string): Promise<boolean> {
  const redis = getRedis()
  return await redis.sismember('optouts', phone)
}

// Get campaign
async function getCampaign(id: string) {
  const redis = getRedis()
  const data = await redis.get(`campaign:${id}`)
  if (!data) return null
  return typeof data === 'string' ? JSON.parse(data) : data
}

// Increment campaign stats
async function incrementStats(campaignId: string, field: string) {
  const redis = getRedis()
  const campaign = await getCampaign(campaignId)
  if (!campaign) return

  campaign.stats[field] = (campaign.stats[field] || 0) + 1

  // Auto-complete single-day campaigns
  if (!campaign.multiDay && campaign.status === 'running') {
    const { sent, failed, skipped, queued } = campaign.stats
    if (queued > 0 && sent + failed + skipped >= queued) {
      campaign.status = 'completed'
    }
  }

  await redis.set(`campaign:${campaignId}`, JSON.stringify(campaign))
}

// Increment variant stats
async function incrementVariantStats(campaignId: string, variantId: string, field: string) {
  const redis = getRedis()
  const campaign = await getCampaign(campaignId)
  if (!campaign?.variants) return

  const variant = campaign.variants.find((v: { id: string }) => v.id === variantId)
  if (variant) {
    variant.stats[field] = (variant.stats[field] || 0) + 1
    await redis.set(`campaign:${campaignId}`, JSON.stringify(campaign))
  }
}

// Add phone to campaign contacts
async function addCampaignContact(campaignId: string, phone: string, variant?: string) {
  const redis = getRedis()
  const value = variant ? `${phone}:${variant}` : phone
  await redis.sadd(`campaign:${campaignId}:contacts`, value)
}

// Add to ever-messaged list
async function addToEverMessaged(phone: string) {
  const redis = getRedis()
  await redis.sadd('ever-messaged', phone)
}

async function handler(request: Request) {
  try {
    const payload: SendPayload = await request.json()

    console.log('Processing campaign message', {
      campaignId: payload.campaignId,
      phone: payload.phone,
      variant: payload.variant,
    })

    // Check if campaign is paused
    const campaign = await getCampaign(payload.campaignId)
    if (campaign?.status === 'paused') {
      console.log('Skipping paused campaign', { campaignId: payload.campaignId })
      return NextResponse.json({ success: true, skipped: true, reason: 'campaign-paused' })
    }

    // Check opt-out list
    if (await isOptedOut(payload.phone)) {
      console.log('Skipping opted-out phone', { phone: payload.phone })
      await incrementStats(payload.campaignId, 'skipped')
      return NextResponse.json({ success: true, skipped: true, reason: 'opted-out' })
    }

    // Send the message
    try {
      const { phoneNumber } = getQuoConfig()
      const result = await sendMessage(phoneNumber, payload.phone, payload.message)

      // Track contact and update stats
      await addCampaignContact(payload.campaignId, payload.phone, payload.variant)
      await addToEverMessaged(payload.phone)
      await incrementStats(payload.campaignId, 'sent')

      if (payload.variant) {
        await incrementVariantStats(payload.campaignId, payload.variant, 'sent')
      }

      console.log('Campaign message sent', {
        campaignId: payload.campaignId,
        phone: payload.phone,
        messageId: result.id,
      })

      return NextResponse.json({ success: true, messageId: result.id })
    } catch (sendError) {
      console.error('Failed to send campaign message', sendError)
      await incrementStats(payload.campaignId, 'failed')
      // Return 200 to prevent QStash retry
      return NextResponse.json({ success: false, error: 'send-failed' })
    }
  } catch (error) {
    console.error('Campaign send handler error', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// Wrap with QStash signature verification
export const POST = verifySignatureAppRouter(handler)
