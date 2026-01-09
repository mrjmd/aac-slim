import { NextResponse } from 'next/server'
import { Redis } from '@upstash/redis'

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

interface CampaignStats {
  total: number
  queued: number
  sent: number
  failed: number
  skipped: number
}

interface MultiDayConfig {
  nextBatchAt?: string
  totalContacts: number
}

interface Campaign {
  id: string
  name: string
  status: 'pending' | 'running' | 'paused' | 'completed'
  stats: CampaignStats
  multiDay?: MultiDayConfig
  [key: string]: unknown
}

/**
 * Return the stored status - don't auto-complete
 * User must manually archive campaigns
 */
function deriveStatus(campaign: Campaign): Campaign['status'] {
  return campaign.status
}

// Pause a campaign
export async function POST(request: Request) {
  try {
    const redis = getRedis()
    const { searchParams } = new URL(request.url)
    const id = searchParams.get('id')

    if (!id) {
      return NextResponse.json({ error: 'Campaign ID required' }, { status: 400 })
    }

    const data = await redis.get(`campaign:${id}`)
    if (!data) {
      return NextResponse.json({ error: 'Campaign not found' }, { status: 404 })
    }

    const campaign = (typeof data === 'string' ? JSON.parse(data) : data) as Campaign
    const actualStatus = deriveStatus(campaign)

    // Can only pause running campaigns
    if (actualStatus !== 'running') {
      return NextResponse.json(
        { error: `Cannot pause campaign with status '${actualStatus}'` },
        { status: 400 }
      )
    }

    campaign.status = 'paused'
    await redis.set(`campaign:${id}`, JSON.stringify(campaign))

    return NextResponse.json({ success: true, status: 'paused' })
  } catch (error) {
    console.error('Campaign pause error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// Resume a paused campaign
export async function DELETE(request: Request) {
  try {
    const redis = getRedis()
    const { searchParams } = new URL(request.url)
    const id = searchParams.get('id')

    if (!id) {
      return NextResponse.json({ error: 'Campaign ID required' }, { status: 400 })
    }

    const data = await redis.get(`campaign:${id}`)
    if (!data) {
      return NextResponse.json({ error: 'Campaign not found' }, { status: 404 })
    }

    const campaign = (typeof data === 'string' ? JSON.parse(data) : data) as Campaign

    // Can only resume paused campaigns
    if (campaign.status !== 'paused') {
      return NextResponse.json(
        { error: `Cannot resume campaign with status '${campaign.status}'` },
        { status: 400 }
      )
    }

    campaign.status = 'running'
    await redis.set(`campaign:${id}`, JSON.stringify(campaign))

    return NextResponse.json({ success: true, status: 'running' })
  } catch (error) {
    console.error('Campaign resume error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
