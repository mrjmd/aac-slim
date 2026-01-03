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

// Archive a campaign
export async function POST(request: Request) {
  try {
    const redis = getRedis()
    const { searchParams } = new URL(request.url)
    const id = searchParams.get('id')

    if (!id) {
      return NextResponse.json({ error: 'Campaign ID required' }, { status: 400 })
    }

    // Verify campaign exists
    const campaign = await redis.get(`campaign:${id}`)
    if (!campaign) {
      return NextResponse.json({ error: 'Campaign not found' }, { status: 404 })
    }

    // Move from active to archived set
    await redis.srem('campaigns:active', id)
    await redis.sadd('campaigns:archived', id)

    return NextResponse.json({ success: true, archived: id })
  } catch (error) {
    console.error('Campaign archive error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// Restore a campaign from archive
export async function DELETE(request: Request) {
  try {
    const redis = getRedis()
    const { searchParams } = new URL(request.url)
    const id = searchParams.get('id')

    if (!id) {
      return NextResponse.json({ error: 'Campaign ID required' }, { status: 400 })
    }

    // Verify campaign exists
    const campaign = await redis.get(`campaign:${id}`)
    if (!campaign) {
      return NextResponse.json({ error: 'Campaign not found' }, { status: 404 })
    }

    // Move from archived back to active set
    await redis.srem('campaigns:archived', id)
    await redis.sadd('campaigns:active', id)

    return NextResponse.json({ success: true, restored: id })
  } catch (error) {
    console.error('Campaign restore error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// Get list of archived campaigns
export async function GET() {
  try {
    const redis = getRedis()
    const campaignIds = await redis.smembers('campaigns:archived') as string[]

    interface CampaignStats {
      total: number
      queued: number
      sent: number
      failed: number
      skipped: number
      responses: number
      optOuts: number
    }

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
        const campaign = typeof data === 'string' ? JSON.parse(data) : data
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
  } catch (error) {
    console.error('Get archived campaigns error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
