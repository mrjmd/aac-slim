import { NextResponse } from 'next/server'
import { Redis } from '@upstash/redis'

// Force dynamic rendering
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

function getRedis() {
  const url = process.env.UPSTASH_REDIS_REST_URL
  const token = process.env.UPSTASH_REDIS_REST_TOKEN

  if (!url || !token) {
    console.error('Redis env vars missing:', { hasUrl: !!url, hasToken: !!token })
    throw new Error('Redis environment variables not configured')
  }
  return new Redis({ url, token })
}

interface CampaignStats {
  total: number
  queued: number
  sent: number
  failed: number
  skipped: number
  responses: number
  optOuts: number
}

interface CampaignVariant {
  id: string
  message: string
  weight: number
  stats: {
    sent: number
    responses: number
    optOuts: number
  }
}

interface Campaign {
  id: string
  name: string
  status: 'pending' | 'running' | 'paused' | 'completed'
  messageTemplate: string
  variants?: CampaignVariant[]
  createdAt: string
  stats: CampaignStats
}

function calcResponseRate(responses: number, sent: number): string {
  return sent > 0 ? ((responses / sent) * 100).toFixed(1) : '0.0'
}

function analyzeVariants(variants: CampaignVariant[]) {
  const analyzed = variants.map((v) => ({
    id: v.id,
    message: v.message.substring(0, 50) + (v.message.length > 50 ? '...' : ''),
    sent: v.stats.sent,
    responses: v.stats.responses,
    optOuts: v.stats.optOuts,
    responseRate: `${calcResponseRate(v.stats.responses, v.stats.sent)}%`,
  }))

  const insights: string[] = []
  const sufficientData = variants.every((v) => v.stats.sent >= 10)

  if (!sufficientData) {
    insights.push('Collecting more data for statistical significance...')
  } else {
    const rates = variants.map((v) => ({
      id: v.id,
      rate: v.stats.sent > 0 ? v.stats.responses / v.stats.sent : 0,
    }))
    rates.sort((a, b) => b.rate - a.rate)

    if (rates.length >= 2 && rates[0].rate > 0) {
      const winner = rates[0]
      const runnerUp = rates[1]
      if (runnerUp.rate > 0) {
        const improvement = ((winner.rate - runnerUp.rate) / runnerUp.rate) * 100
        if (improvement >= 20) {
          insights.push(`Variant ${winner.id} is performing ${improvement.toFixed(0)}% better than ${runnerUp.id}`)
        } else if (improvement >= 5) {
          insights.push(`Variant ${winner.id} has a slight edge over ${runnerUp.id}`)
        } else {
          insights.push('Both variants are performing similarly')
        }
      } else {
        insights.push(`Variant ${winner.id} is the only one with responses so far`)
      }
    }

    const highOptOut = variants.find((v) => v.stats.sent > 0 && v.stats.optOuts / v.stats.sent > 0.05)
    if (highOptOut) {
      const rate = ((highOptOut.stats.optOuts / highOptOut.stats.sent) * 100).toFixed(1)
      insights.push(`Warning: Variant ${highOptOut.id} has a high opt-out rate (${rate}%)`)
    }
  }

  return { variants: analyzed, insights }
}

export async function GET(request: Request) {
  try {
    const redis = getRedis()
    const { searchParams } = new URL(request.url)
    const id = searchParams.get('id')

    // If no ID provided, list all active campaigns
    if (!id) {
      const campaignIds = await redis.smembers('campaigns:active') as string[]
      const campaigns: Array<{
        id: string
        name: string
        status: string
        createdAt: string
        hasVariants: boolean
        stats: CampaignStats
      }> = []

      for (const cid of campaignIds) {
        const data = await redis.get(`campaign:${cid}`)
        if (data) {
          const campaign = typeof data === 'string' ? JSON.parse(data) : data as Campaign
          campaigns.push({
            id: campaign.id,
            name: campaign.name,
            status: campaign.status,
            createdAt: campaign.createdAt,
            hasVariants: !!campaign.variants,
            stats: campaign.stats,
          })
        }
      }

      return NextResponse.json({ success: true, campaigns })
    }

    // Get specific campaign
    const data = await redis.get(`campaign:${id}`)
    if (!data) {
      return NextResponse.json({ error: 'Campaign not found' }, { status: 404 })
    }

    const campaign = typeof data === 'string' ? JSON.parse(data) : data as Campaign
    const responseRate = calcResponseRate(campaign.stats.responses, campaign.stats.sent)

    const response: Record<string, unknown> = {
      success: true,
      campaign: {
        id: campaign.id,
        name: campaign.name,
        status: campaign.status,
        createdAt: campaign.createdAt,
        messageTemplate: campaign.messageTemplate,
        stats: {
          ...campaign.stats,
          responseRate: `${responseRate}%`,
        },
      },
    }

    if (campaign.variants && campaign.variants.length > 0) {
      const analysis = analyzeVariants(campaign.variants)
      ;(response.campaign as Record<string, unknown>).abTest = {
        variants: analysis.variants,
        insights: analysis.insights,
      }
    }

    return NextResponse.json(response)
  } catch (error) {
    console.error('Campaign stats error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
