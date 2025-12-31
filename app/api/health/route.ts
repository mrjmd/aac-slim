import { NextResponse } from 'next/server'
import { Redis } from '@upstash/redis'

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
})

interface HealthMetrics {
  webhooks: {
    pipedrive: { processed24h: number; lastProcessed: string | null }
    quo: { processed24h: number; lastProcessed: string | null }
    googleAds: { processed24h: number; lastProcessed: string | null }
  }
  sync: {
    pdToQuo: number
    pdToQb: number
    phoneToPd: number
  }
  campaigns: {
    active: number
    totalSent24h: number
    totalResponses24h: number
    optOuts24h: number
  }
  errors: Array<{
    timestamp: string
    source: string
    message: string
    details?: string
  }>
  qstash: {
    pending: number
    failed: number
  }
}

export async function GET() {
  try {
    const metrics: HealthMetrics = {
      webhooks: {
        pipedrive: { processed24h: 0, lastProcessed: null },
        quo: { processed24h: 0, lastProcessed: null },
        googleAds: { processed24h: 0, lastProcessed: null },
      },
      sync: { pdToQuo: 0, pdToQb: 0, phoneToPd: 0 },
      campaigns: { active: 0, totalSent24h: 0, totalResponses24h: 0, optOuts24h: 0 },
      errors: [],
      qstash: { pending: 0, failed: 0 },
    }

    // Get webhook stats from Redis counters
    const today = new Date().toISOString().split('T')[0]
    const [pdCount, quoCount, gadsCount] = await Promise.all([
      redis.get(`webhooks:pipedrive:${today}:count`),
      redis.get(`webhooks:quo:${today}:count`),
      redis.get(`webhooks:google-ads:${today}:count`),
    ])

    metrics.webhooks.pipedrive.processed24h = Number(pdCount) || 0
    metrics.webhooks.quo.processed24h = Number(quoCount) || 0
    metrics.webhooks.googleAds.processed24h = Number(gadsCount) || 0

    // Get last processed timestamps
    const [pdLast, quoLast, gadsLast] = await Promise.all([
      redis.get(`webhooks:pipedrive:last`),
      redis.get(`webhooks:quo:last`),
      redis.get(`webhooks:google-ads:last`),
    ])

    metrics.webhooks.pipedrive.lastProcessed = pdLast as string | null
    metrics.webhooks.quo.lastProcessed = quoLast as string | null
    metrics.webhooks.googleAds.lastProcessed = gadsLast as string | null

    // Count mappings using Redis SCAN
    let pdToQuoCount = 0
    let pdToQbCount = 0
    let phoneToPdCount = 0

    // Get approximate mapping counts using single scans
    const [pdQuoResult, pdQbResult, phonePdResult] = await Promise.all([
      redis.scan(0, { match: 'map:pd-to-quo:*', count: 500 }),
      redis.scan(0, { match: 'map:pd-to-qb:*', count: 500 }),
      redis.scan(0, { match: 'phone:pd:*', count: 500 }),
    ])

    pdToQuoCount = (pdQuoResult[1] as string[]).length
    pdToQbCount = (pdQbResult[1] as string[]).length
    phoneToPdCount = (phonePdResult[1] as string[]).length

    metrics.sync.pdToQuo = pdToQuoCount
    metrics.sync.pdToQb = pdToQbCount
    metrics.sync.phoneToPd = phoneToPdCount

    // Get active campaigns and aggregate stats
    const activeCampaigns = await redis.smembers('campaigns:active') as string[]
    metrics.campaigns.active = activeCampaigns.length

    // Aggregate campaign stats
    for (const campaignId of activeCampaigns.slice(0, 10)) {
      const campaignData = await redis.get(`campaign:${campaignId}`)
      if (campaignData) {
        const campaign = typeof campaignData === 'string' ? JSON.parse(campaignData) : campaignData
        if (campaign.stats) {
          metrics.campaigns.totalSent24h += campaign.stats.sent || 0
          metrics.campaigns.totalResponses24h += campaign.stats.responses || 0
          metrics.campaigns.optOuts24h += campaign.stats.optOuts || 0
        }
      }
    }

    // Get recent errors from Redis list
    const errors = await redis.lrange('health:errors', 0, 9) as string[]
    metrics.errors = errors.map(e => {
      try {
        return typeof e === 'string' ? JSON.parse(e) : e
      } catch {
        return { timestamp: new Date().toISOString(), source: 'unknown', message: String(e) }
      }
    })

    // Get QStash queue status (if API key available)
    if (process.env.QSTASH_TOKEN) {
      try {
        const qstashRes = await fetch('https://qstash.upstash.io/v2/messages', {
          headers: { Authorization: `Bearer ${process.env.QSTASH_TOKEN}` },
        })
        if (qstashRes.ok) {
          const messages = await qstashRes.json()
          if (Array.isArray(messages)) {
            metrics.qstash.pending = messages.filter((m: { state?: string }) => m.state === 'PENDING' || m.state === 'SCHEDULED').length
            metrics.qstash.failed = messages.filter((m: { state?: string }) => m.state === 'FAILED' || m.state === 'ERROR').length
          }
        }
      } catch {
        // QStash API unavailable, leave at 0
      }
    }

    return NextResponse.json(metrics)
  } catch (error) {
    console.error('Health check error:', error)
    return NextResponse.json(
      { error: 'Failed to fetch health metrics' },
      { status: 500 }
    )
  }
}
