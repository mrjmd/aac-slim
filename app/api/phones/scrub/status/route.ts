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

      // ALWAYS run filter with includeDnc=false first to get accurate DNC list for caching
      // This ensures DNC phones are always cached as DNC, regardless of campaign settings
      const scrubbedForCache = filterResults(result.DATA || [], { includeDnc: false })

      // Now get results based on actual includeDnc setting for response
      const scrubbed = includeDnc
        ? filterResults(result.DATA || [], { includeDnc: true })
        : scrubbedForCache

      // IMPORTANT: Cache ALL attributes from raw SearchBug data, not just filtered results
      // filterResults uses priority order (DNC before landline) but we need to cache ALL
      // This prevents a DNC+landline from passing through when includeDnc=true
      const rawData = result.DATA || []

      // Cache based on raw SearchBug attributes, not filtered results
      const dncPhones = rawData.filter(r => r.DNC !== 'NO').map(r => r.NUMBER)
      const litigatorPhones = rawData.filter(r => r.TCPA === 'YES').map(r => r.NUMBER)
      const landlinePhones = rawData.filter(r => r.TYPE === 'LANDLINE').map(r => r.NUMBER)
      const inactivePhones = rawData.filter(r => r.STATUS === 'INACTIVE' || r.STATUS === 'INVALID').map(r => r.NUMBER)
      // Only truly clean phones go to verified-clean cache (no DNC, no landline, no litigator, active)
      const cleanPhones = rawData.filter(r =>
        r.DNC === 'NO' &&
        r.TCPA !== 'YES' &&
        r.TYPE !== 'LANDLINE' &&
        r.STATUS !== 'INACTIVE' &&
        r.STATUS !== 'INVALID'
      ).map(r => r.NUMBER)

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
