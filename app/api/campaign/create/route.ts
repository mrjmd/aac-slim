import { NextResponse } from 'next/server'
import { parse } from 'csv-parse/sync'
import { Redis } from '@upstash/redis'
import { Client } from '@upstash/qstash'

// Initialize clients directly to avoid import issues with .js extensions
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
})

const qstash = new Client({
  token: process.env.QSTASH_TOKEN!,
})

interface CreateCampaignRequest {
  name: string
  csvData: string
  message?: string
  messageA?: string
  messageB?: string
  dryRun?: boolean
  skipDedup?: boolean
}

interface NormalizedContact {
  firstName: string
  lastName: string | null
  phone: string
  email: string | null
  city: string
  subdivision: string | null
  address: string | null
  zip: string | null
}

interface CampaignVariant {
  id: string
  message: string
  stats: { sent: number; responses: number; optOuts: number }
}

// ============================================
// Utility functions (duplicated to avoid import issues)
// ============================================

function normalizePhone(phone: string): string | null {
  if (!phone) return null
  const digits = phone.replace(/\D/g, '')
  if (digits.length === 10) return `+1${digits}`
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`
  if (digits.length > 10 && digits.length <= 15) return `+${digits}`
  return null
}

function normalizeName(fullName: string): { firstName: string; lastName: string | null } {
  if (!fullName?.trim()) return { firstName: 'Homeowner', lastName: null }
  const parts = fullName.trim().split(/\s+/)
  const titleCase = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase()
  if (parts.length === 1) return { firstName: titleCase(parts[0]), lastName: null }
  return { firstName: titleCase(parts[0]), lastName: parts.slice(1).map(titleCase).join(' ') }
}

function parseCSV(csvContent: string): { contacts: NormalizedContact[]; stats: Record<string, number> } {
  const stats = {
    totalRows: 0, primaryContacts: 0, secondaryContacts: 0,
    skippedNoPhone: 0, skippedInactivePhone: 0, skippedInvalidPhone: 0,
  }
  const contacts: NormalizedContact[] = []

  const rows = parse(csvContent, {
    columns: true, skip_empty_lines: true, trim: true, relax_column_count: true,
  }) as Record<string, string>[]

  stats.totalRows = rows.length

  for (const row of rows) {
    const primaryPhone = row['Primary Mobile Phone1']
    const primaryStatus = row['Primary Mobile 1 Status']

    if (!primaryPhone) {
      stats.skippedNoPhone++
    } else if (primaryStatus && primaryStatus.toLowerCase() !== 'active') {
      stats.skippedInactivePhone++
    } else {
      const normalizedPhone = normalizePhone(primaryPhone)
      if (!normalizedPhone) {
        stats.skippedInvalidPhone++
      } else {
        const { firstName, lastName } = normalizeName(row['Primary Name'] || '')
        contacts.push({
          firstName, lastName, phone: normalizedPhone,
          email: row['Primary Email1'] || null,
          city: row['City'] || 'Unknown',
          subdivision: row['Subdivision'] !== row['City'] ? row['Subdivision'] || null : null,
          address: row['Address'] || null,
          zip: row['ZIP'] || null,
        })
        stats.primaryContacts++
      }
    }

    // Secondary contact
    const secondaryPhone = row['Secondary Mobile Phone1']
    if (secondaryPhone) {
      const normalizedPhone = normalizePhone(secondaryPhone)
      if (normalizedPhone) {
        const { firstName, lastName } = normalizeName(row['Secondary Name'] || '')
        contacts.push({
          firstName, lastName, phone: normalizedPhone, email: null,
          city: row['City'] || 'Unknown',
          subdivision: row['Subdivision'] !== row['City'] ? row['Subdivision'] || null : null,
          address: row['Address'] || null, zip: row['ZIP'] || null,
        })
        stats.secondaryContacts++
      }
    }
  }

  return { contacts, stats }
}

function personalizeMessage(template: string, contact: NormalizedContact): string {
  return template
    .replace(/\{firstName\}/g, contact.firstName)
    .replace(/\{lastName\}/g, contact.lastName || '')
    .replace(/\{city\}/g, contact.city)
    .replace(/\{neighborhood\}/g, contact.subdivision || contact.city)
}

function selectVariant(variants: CampaignVariant[]): CampaignVariant {
  const random = Math.random() * 100
  let cumulative = 0
  for (const variant of variants) {
    cumulative += 50 // Equal weights
    if (random < cumulative) return variant
  }
  return variants[variants.length - 1]
}

// ============================================
// Redis operations
// ============================================

async function createCampaign(id: string, name: string, message: string, variants?: CampaignVariant[]) {
  const campaign = {
    id, name, messageTemplate: message, status: 'pending',
    createdAt: new Date().toISOString(),
    stats: { total: 0, queued: 0, sent: 0, failed: 0, skipped: 0, responses: 0, optOuts: 0 },
    variants,
  }
  await redis.set(`campaign:${id}`, JSON.stringify(campaign))
  await redis.sadd('campaigns:active', id)
  await redis.expire(`campaign:${id}`, 90 * 24 * 60 * 60) // 90 days TTL
}

async function incrementStats(campaignId: string, updates: Record<string, number>) {
  const key = `campaign:${campaignId}`
  const raw = await redis.get(key) as string | null
  if (!raw) return
  const campaign = JSON.parse(raw)
  for (const [field, delta] of Object.entries(updates)) {
    campaign.stats[field] = (campaign.stats[field] || 0) + delta
  }
  await redis.set(key, JSON.stringify(campaign))
}

async function updateStatus(campaignId: string, status: string) {
  const key = `campaign:${campaignId}`
  const raw = await redis.get(key) as string | null
  if (!raw) return
  const campaign = JSON.parse(raw)
  campaign.status = status
  await redis.set(key, JSON.stringify(campaign))
}

// ============================================
// External API calls
// ============================================

async function hasExistingConversation(phone: string): Promise<boolean> {
  const apiKey = process.env.QUO_API_KEY
  if (!apiKey) return false

  try {
    const res = await fetch(
      `https://api.openphone.com/v1/conversations?participants=${encodeURIComponent(phone)}&maxResults=1`,
      { headers: { Authorization: apiKey } }
    )
    if (!res.ok) return false
    const data = await res.json()
    return data.data && data.data.length > 0
  } catch {
    return false
  }
}

async function createPipedriveContact(contact: NormalizedContact, campaignName: string): Promise<{ id: number; created: boolean }> {
  const apiKey = process.env.PIPEDRIVE_API_KEY
  const domain = process.env.PIPEDRIVE_COMPANY_DOMAIN

  // Search for existing
  const searchRes = await fetch(
    `https://${domain}.pipedrive.com/api/v1/persons/search?term=${encodeURIComponent(contact.phone)}&fields=phone&api_token=${apiKey}`
  )
  const searchData = await searchRes.json()

  if (searchData.data?.items?.length > 0) {
    return { id: searchData.data.items[0].item.id, created: false }
  }

  // Create new
  const createRes = await fetch(
    `https://${domain}.pipedrive.com/api/v1/persons?api_token=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: `${contact.firstName} ${contact.lastName || ''}`.trim(),
        phone: [{ value: contact.phone, primary: true, label: 'mobile' }],
        email: contact.email ? [{ value: contact.email, primary: true, label: 'work' }] : undefined,
        visible_to: 3,
        // Custom field for lead source
        '9c5cc1715fdd7b997dbd81a09c75f2c399f29dee': `Campaign: ${campaignName}`,
      }),
    }
  )
  const createData = await createRes.json()
  return { id: createData.data.id, created: true }
}

// ============================================
// Main handler
// ============================================

export async function POST(request: Request) {
  try {
    const body: CreateCampaignRequest = await request.json()
    const { name, csvData, message, messageA, messageB, dryRun, skipDedup } = body

    if (!name || !csvData) {
      return NextResponse.json({ error: 'name and csvData are required' }, { status: 400 })
    }

    const hasMessage = !!message
    const hasABTest = !!messageA && !!messageB

    if (!hasMessage && !hasABTest) {
      return NextResponse.json({ error: 'Either message OR both messageA and messageB are required' }, { status: 400 })
    }

    if (hasMessage && hasABTest) {
      return NextResponse.json({ error: 'Cannot use message with messageA/messageB' }, { status: 400 })
    }

    // Parse CSV
    const { contacts, stats: parseStats } = parseCSV(csvData)
    if (contacts.length === 0) {
      return NextResponse.json({ error: 'No valid contacts found in CSV', parseStats }, { status: 400 })
    }

    // Build variants
    const variants: CampaignVariant[] | undefined = hasABTest
      ? [
          { id: 'A', message: messageA!, stats: { sent: 0, responses: 0, optOuts: 0 } },
          { id: 'B', message: messageB!, stats: { sent: 0, responses: 0, optOuts: 0 } },
        ]
      : undefined

    const campaignId = `campaign-${name.toLowerCase().replace(/[^a-z0-9-]/g, '-')}`
    const defaultMessage = message || messageA!

    if (!dryRun) {
      await createCampaign(campaignId, name, defaultMessage, variants)
      await incrementStats(campaignId, { total: contacts.length })
    }

    const callbackUrl = `${process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'https://aac-middleware.vercel.app'}/api/campaign/send`

    const results = {
      campaignId, parseStats, processed: 0, queued: 0, skipped: 0, pipedriveCreated: 0,
      variantCounts: { A: 0, B: 0 } as Record<string, number>,
      preview: [] as Array<{ phone: string; name: string; city: string; message: string; variant?: string }>,
    }

    let queueIndex = 0

    for (const contact of contacts) {
      results.processed++

      // Dedup check
      if (!skipDedup && !dryRun) {
        const hasConversation = await hasExistingConversation(contact.phone)
        if (hasConversation) {
          results.skipped++
          await incrementStats(campaignId, { skipped: 1 })
          continue
        }
      }

      // Select variant
      let messageTemplate: string
      let variantId: string | undefined

      if (hasABTest && variants) {
        const selected = selectVariant(variants)
        messageTemplate = selected.message
        variantId = selected.id
        results.variantCounts[variantId]++
      } else {
        messageTemplate = message!
      }

      const personalizedMessage = personalizeMessage(messageTemplate, contact)

      // Dry run: collect preview
      if (dryRun) {
        if (results.preview.length < 10) {
          results.preview.push({
            phone: contact.phone,
            name: `${contact.firstName} ${contact.lastName || ''}`.trim(),
            city: contact.city,
            message: personalizedMessage,
            variant: variantId,
          })
        }
        results.queued++
        continue
      }

      // Create Pipedrive contact
      const { id: personId, created } = await createPipedriveContact(contact, name)
      if (created) results.pipedriveCreated++

      // Queue message via QStash
      const delay = Math.floor(queueIndex * 2.5) // 2.5s between messages
      await qstash.publishJSON({
        url: callbackUrl,
        delay,
        body: {
          campaignId,
          pipedrivePersonId: personId,
          phone: contact.phone,
          message: personalizedMessage,
          variant: variantId,
        },
      })
      await incrementStats(campaignId, { queued: 1 })

      results.queued++
      queueIndex++
    }

    if (!dryRun) {
      await updateStatus(campaignId, 'running')
    }

    return NextResponse.json({
      success: true,
      dryRun: !!dryRun,
      ...results,
      estimatedMinutes: Math.ceil((results.queued * 2.5) / 60),
    })
  } catch (error) {
    console.error('Campaign create error:', error)
    return NextResponse.json({ error: (error as Error).message }, { status: 500 })
  }
}
