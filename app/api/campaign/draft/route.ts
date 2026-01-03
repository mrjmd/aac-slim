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

const DRAFT_PREFIX = 'campaign:draft:'
const DRAFT_LIST_KEY = 'campaign:drafts'
const DRAFT_TTL = 60 * 60 * 24 * 30 // 30 days

export interface CampaignDraft {
  id: string
  name: string
  csvData: string
  contactCount: number
  message?: string
  messageA?: string
  messageB?: string
  isABTest: boolean
  skipDedup: boolean
  followUpEnabled: boolean
  followUpDays?: number
  followUpMessage?: string
  scheduleEnabled: boolean
  scheduledDate?: string
  scheduledTime?: string
  createdAt: string
  updatedAt: string
}

// GET - List all drafts or get a specific draft
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url)
    const id = searchParams.get('id')
    const redis = getRedis()

    if (id) {
      // Get specific draft
      const draft = await redis.get<CampaignDraft>(`${DRAFT_PREFIX}${id}`)
      if (!draft) {
        return NextResponse.json({ error: 'Draft not found' }, { status: 404 })
      }
      return NextResponse.json(draft)
    }

    // List all drafts
    const draftIds = await redis.smembers(DRAFT_LIST_KEY)
    const drafts: CampaignDraft[] = []

    for (const draftId of draftIds) {
      const draft = await redis.get<CampaignDraft>(`${DRAFT_PREFIX}${draftId}`)
      if (draft) {
        // Don't include full CSV data in list view
        drafts.push({
          ...draft,
          csvData: '', // Strip CSV data for list view
        })
      } else {
        // Clean up stale reference
        await redis.srem(DRAFT_LIST_KEY, draftId)
      }
    }

    // Sort by updatedAt descending
    drafts.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())

    return NextResponse.json({ drafts })
  } catch (error) {
    console.error('Draft GET error:', error)
    return NextResponse.json({ error: (error as Error).message }, { status: 500 })
  }
}

// POST - Create or update a draft
export async function POST(request: Request) {
  try {
    const body = await request.json()
    const redis = getRedis()

    const now = new Date().toISOString()
    const id = body.id || `draft-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

    const draft: CampaignDraft = {
      id,
      name: body.name || 'Untitled Draft',
      csvData: body.csvData || '',
      contactCount: body.contactCount || 0,
      message: body.message,
      messageA: body.messageA,
      messageB: body.messageB,
      isABTest: body.isABTest || false,
      skipDedup: body.skipDedup || false,
      followUpEnabled: body.followUpEnabled || false,
      followUpDays: body.followUpDays,
      followUpMessage: body.followUpMessage,
      scheduleEnabled: body.scheduleEnabled || false,
      scheduledDate: body.scheduledDate,
      scheduledTime: body.scheduledTime,
      createdAt: body.createdAt || now,
      updatedAt: now,
    }

    // Save draft with TTL
    await redis.set(`${DRAFT_PREFIX}${id}`, draft, { ex: DRAFT_TTL })

    // Add to drafts list
    await redis.sadd(DRAFT_LIST_KEY, id)

    return NextResponse.json({ success: true, draft })
  } catch (error) {
    console.error('Draft POST error:', error)
    return NextResponse.json({ error: (error as Error).message }, { status: 500 })
  }
}

// DELETE - Delete a draft
export async function DELETE(request: Request) {
  try {
    const { searchParams } = new URL(request.url)
    const id = searchParams.get('id')

    if (!id) {
      return NextResponse.json({ error: 'Draft ID required' }, { status: 400 })
    }

    const redis = getRedis()

    // Delete draft
    await redis.del(`${DRAFT_PREFIX}${id}`)

    // Remove from list
    await redis.srem(DRAFT_LIST_KEY, id)

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('Draft DELETE error:', error)
    return NextResponse.json({ error: (error as Error).message }, { status: 500 })
  }
}
