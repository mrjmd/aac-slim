import { NextResponse } from 'next/server'
import { Redis } from '@upstash/redis'
import { getValidationResults, filterResults } from '@/src/clients/searchbug'
import {
  addManyToDncList,
  addManyToLitigatorList,
  addManyToLandlineList,
  addManyToInactiveList,
  addManyToVerifiedClean,
} from '@/app/lib/suppression'

function getRedis() {
  const url = process.env.UPSTASH_REDIS_REST_URL
  const token = process.env.UPSTASH_REDIS_REST_TOKEN
  if (!url || !token) {
    throw new Error('Redis environment variables not configured')
  }
  return new Redis({ url, token })
}

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function POST(request: Request) {
  try {
    const body = await request.json()
    const { key } = body

    if (!key) {
      return NextResponse.json(
        { error: 'key is required' },
        { status: 400 }
      )
    }

    // Poll SearchBug
    const result = await getValidationResults(key)

    if (result.STATUS === 'Running') {
      return NextResponse.json({
        status: 'running',
        processed: result.PROCESSED,
        percent: result.PERCENT,
        minutesLeft: result.MINLEFT,
      })
    }

    if (result.STATUS === 'Failed' || result.STATUS === 'Stopped') {
      return NextResponse.json({
        status: 'failed',
        error: result.ERROR || 'Validation stopped or failed',
      })
    }

    if (result.STATUS === 'Complete') {
      // Check if includeDnc setting was stored with this scrub
      const redis = getRedis()
      const settingsRaw = await redis.get(`scrub:settings:${key}`)
      const settings = settingsRaw ? JSON.parse(settingsRaw as string) : {}
      const includeDnc = settings.includeDnc || false

      // Filter and categorize results
      const scrubbed = filterResults(result.DATA || [], { includeDnc })

      // Save all results to our internal caches
      // This prevents us from paying to re-check them in future campaigns
      const dncPhones = scrubbed.removed.dnc.map(r => r.NUMBER)
      const litigatorPhones = scrubbed.removed.litigator.map(r => r.NUMBER)
      const landlinePhones = scrubbed.removed.landline.map(r => r.NUMBER)
      const inactivePhones = scrubbed.removed.inactive.map(r => r.NUMBER)
      const cleanPhones = scrubbed.clean.map(r => r.NUMBER)

      await Promise.all([
        addManyToDncList(dncPhones),
        addManyToLitigatorList(litigatorPhones),
        addManyToLandlineList(landlinePhones),
        addManyToInactiveList(inactivePhones),
        addManyToVerifiedClean(cleanPhones),
      ])

      return NextResponse.json({
        status: 'complete',
        summary: scrubbed.summary,
        suppressionAdded: {
          dnc: dncPhones.length,
          litigators: litigatorPhones.length,
        },
        clean: scrubbed.clean.map(r => ({
          id: r.ID,
          phone: r.NUMBER,
          carrier: r.CARRIER,
          type: r.TYPE,
          state: r.STATE,
        })),
        removed: {
          dnc: scrubbed.removed.dnc.map(r => ({
            id: r.ID,
            phone: r.NUMBER,
            reason: `DNC: ${r.DNC}`,
          })),
          litigator: scrubbed.removed.litigator.map(r => ({
            id: r.ID,
            phone: r.NUMBER,
            reason: 'TCPA Litigator',
          })),
          landline: scrubbed.removed.landline.map(r => ({
            id: r.ID,
            phone: r.NUMBER,
            reason: 'Landline (cannot receive SMS)',
          })),
          inactive: scrubbed.removed.inactive.map(r => ({
            id: r.ID,
            phone: r.NUMBER,
            reason: `Status: ${r.STATUS}`,
          })),
        },
      })
    }

    return NextResponse.json({
      status: 'unknown',
      raw: result,
    })
  } catch (error) {
    console.error('Phone scrub status error:', error)
    return NextResponse.json(
      { error: (error as Error).message },
      { status: 500 }
    )
  }
}
