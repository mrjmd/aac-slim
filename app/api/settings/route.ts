import { NextResponse } from 'next/server'
import { Redis } from '@upstash/redis'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const SETTINGS_KEY = 'settings:global'

function getRedis() {
  const url = process.env.UPSTASH_REDIS_REST_URL
  const token = process.env.UPSTASH_REDIS_REST_TOKEN

  if (!url || !token) {
    throw new Error('Redis environment variables not configured')
  }
  return new Redis({ url, token })
}

interface GlobalSettings {
  campaign?: {
    optOutFooter: string
    throttleSeconds: number
    dailySendLimit: number      // Max messages per day for large campaigns
    skipWeekends: boolean       // Skip Saturday and Sunday
    defaultStartHour: number    // Default hour to start sending (0-23, local time)
  }
}

// Default settings
const DEFAULT_SETTINGS: GlobalSettings = {
  campaign: {
    optOutFooter: 'Reply STOP to opt out',
    throttleSeconds: 45,      // Conservative default for cold outreach
    dailySendLimit: 125,      // Messages per day for multi-day campaigns
    skipWeekends: true,       // Don't send on weekends by default
    defaultStartHour: 9,      // Start at 9 AM by default
  },
}

export async function GET() {
  try {
    const redis = getRedis()
    const data = await redis.get(SETTINGS_KEY)

    if (!data) {
      return NextResponse.json(DEFAULT_SETTINGS)
    }

    const settings = typeof data === 'string' ? JSON.parse(data) : data
    return NextResponse.json({ ...DEFAULT_SETTINGS, ...settings })
  } catch (error) {
    console.error('Settings GET error:', error)
    return NextResponse.json(DEFAULT_SETTINGS)
  }
}

export async function POST(request: Request) {
  try {
    const redis = getRedis()
    const body = await request.json()

    // Get existing settings
    const existing = await redis.get(SETTINGS_KEY)
    const currentSettings = existing
      ? typeof existing === 'string' ? JSON.parse(existing) : existing
      : DEFAULT_SETTINGS

    // Merge new settings
    const newSettings = {
      ...currentSettings,
      ...body,
    }

    // Validate campaign settings
    if (newSettings.campaign) {
      if (typeof newSettings.campaign.throttleSeconds === 'number') {
        // Allow 1-120 seconds between messages
        newSettings.campaign.throttleSeconds = Math.max(1, Math.min(120, newSettings.campaign.throttleSeconds))
      }
      if (typeof newSettings.campaign.dailySendLimit === 'number') {
        // Allow 10-500 messages per day
        newSettings.campaign.dailySendLimit = Math.max(10, Math.min(500, newSettings.campaign.dailySendLimit))
      }
      if (typeof newSettings.campaign.defaultStartHour === 'number') {
        // Valid hour 0-23
        newSettings.campaign.defaultStartHour = Math.max(0, Math.min(23, newSettings.campaign.defaultStartHour))
      }
    }

    await redis.set(SETTINGS_KEY, JSON.stringify(newSettings))

    return NextResponse.json({ success: true, settings: newSettings })
  } catch (error) {
    console.error('Settings POST error:', error)
    return NextResponse.json({ error: 'Failed to save settings' }, { status: 500 })
  }
}
