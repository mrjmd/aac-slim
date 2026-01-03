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

    // Delete all campaign-related keys
    const keysToDelete = [
      `campaign:${id}`,
      `campaign:${id}:contacts`,
      `campaign:${id}:recipients`,
      `campaign:${id}:pending`,
    ]

    // Delete each key (multi-delete not available in all Redis configs)
    for (const key of keysToDelete) {
      await redis.del(key)
    }

    // Remove from active campaigns set
    await redis.srem('campaigns:active', id)

    return NextResponse.json({ success: true, deleted: id })
  } catch (error) {
    console.error('Campaign delete error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
