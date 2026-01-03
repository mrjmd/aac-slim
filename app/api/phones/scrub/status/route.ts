import { NextResponse } from 'next/server'
import { getValidationResults, filterResults } from '@/src/clients/searchbug'
import { addManyToDncList, addManyToLitigatorList } from '@/app/lib/suppression'

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
      // Filter and categorize results
      const scrubbed = filterResults(result.DATA || [])

      // Save DNC and litigators to our internal suppression lists
      // This prevents us from paying to re-check them in future campaigns
      const dncPhones = scrubbed.removed.dnc.map(r => r.NUMBER)
      const litigatorPhones = scrubbed.removed.litigator.map(r => r.NUMBER)

      await Promise.all([
        addManyToDncList(dncPhones),
        addManyToLitigatorList(litigatorPhones),
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
