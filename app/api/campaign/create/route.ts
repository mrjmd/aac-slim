import { NextResponse } from 'next/server'
import { parse } from 'csv-parse/sync'
import { Redis } from '@upstash/redis'
import { Client } from '@upstash/qstash'
// Note: OpenPhone dedup check removed from here - it's done in prefilter
// Having it in both places caused inconsistent behavior (phones pass prefilter
// but get skipped here if the API was flaky during prefilter)

// Force dynamic rendering
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

// Lazy-load clients to avoid initialization errors
function getRedis() {
  const url = process.env.UPSTASH_REDIS_REST_URL
  const token = process.env.UPSTASH_REDIS_REST_TOKEN

  if (!url || !token) {
    console.error('Redis env vars missing:', { hasUrl: !!url, hasToken: !!token })
    throw new Error('Redis environment variables not configured')
  }
  return new Redis({ url, token })
}

function getQstash() {
  const token = process.env.QSTASH_TOKEN
  if (!token) {
    console.error('QStash token missing')
    throw new Error('QStash token not configured')
  }
  return new Client({ token })
}

interface CreateCampaignRequest {
  name: string
  csvData: string
  message?: string
  messageA?: string
  messageB?: string
  dryRun?: boolean
  skipDedup?: boolean
  scheduledAt?: string // ISO timestamp for scheduled campaigns
  followUp?: {
    delayDays: number
    message: string
  }
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
// Redis operations (pass redis instance to avoid module-level initialization)
// ============================================

interface FollowUpConfig {
  delayDays: number
  message: string
}

interface MultiDayConfig {
  dailyLimit: number
  skipWeekends: boolean
  startHour: number
  totalContacts: number
  currentDay: number
  nextBatchAt?: string // ISO timestamp for next batch
}

async function createCampaignRecord(
  redis: Redis,
  id: string,
  name: string,
  message: string,
  variants?: CampaignVariant[],
  followUp?: FollowUpConfig,
  multiDay?: MultiDayConfig
) {
  const campaign = {
    id, name, messageTemplate: message, status: 'pending',
    createdAt: new Date().toISOString(),
    stats: { total: 0, queued: 0, sent: 0, failed: 0, skipped: 0, responses: 0, optOuts: 0 },
    variants,
    followUp: followUp ? {
      ...followUp,
      sent: 0, // Track how many follow-ups sent
    } : undefined,
    multiDay, // Multi-day batching config
  }
  await redis.set(`campaign:${id}`, JSON.stringify(campaign))
  await redis.sadd('campaigns:active', id)
  await redis.expire(`campaign:${id}`, 90 * 24 * 60 * 60) // 90 days TTL
}

// Store pending contacts for multi-day campaigns
async function storePendingContacts(
  redis: Redis,
  campaignId: string,
  contacts: NormalizedContact[]
) {
  const key = `campaign:${campaignId}:pending`
  // Store as JSON array
  await redis.set(key, JSON.stringify(contacts))
  await redis.expire(key, 90 * 24 * 60 * 60) // 90 days TTL
}

// Calculate next batch time (tomorrow at start hour, skipping weekends if configured)
function calculateNextBatchTime(startHour: number, skipWeekends: boolean): Date {
  const next = new Date()
  next.setDate(next.getDate() + 1) // Tomorrow
  next.setHours(startHour, 0, 0, 0)

  if (skipWeekends) {
    // Skip Saturday (6) and Sunday (0)
    while (next.getDay() === 0 || next.getDay() === 6) {
      next.setDate(next.getDate() + 1)
    }
  }

  return next
}

async function incrementStats(redis: Redis, campaignId: string, updates: Record<string, number>) {
  const key = `campaign:${campaignId}`
  const raw = await redis.get(key)
  if (!raw) return
  // Handle both string and auto-parsed object from Upstash
  const campaign = typeof raw === 'string' ? JSON.parse(raw) : raw
  for (const [field, delta] of Object.entries(updates)) {
    campaign.stats[field] = (campaign.stats[field] || 0) + delta
  }
  await redis.set(key, JSON.stringify(campaign))
}

async function updateStatus(redis: Redis, campaignId: string, status: string) {
  const key = `campaign:${campaignId}`
  const raw = await redis.get(key)
  if (!raw) return
  // Handle both string and auto-parsed object from Upstash
  const campaign = typeof raw === 'string' ? JSON.parse(raw) : raw
  campaign.status = status
  await redis.set(key, JSON.stringify(campaign))
}

// Track recipient for follow-up processing
async function trackRecipient(
  redis: Redis,
  campaignId: string,
  phone: string,
  contact: NormalizedContact,
  variant?: string
) {
  const recipient = {
    phone,
    firstName: contact.firstName,
    lastName: contact.lastName,
    city: contact.city,
    subdivision: contact.subdivision,
    sentAt: new Date().toISOString(),
    responded: false,
    variant,
  }
  // Store in a hash for easy lookup and updates
  await redis.hset(`campaign:${campaignId}:recipients`, { [phone]: JSON.stringify(recipient) })
  // Set TTL on first recipient (90 days)
  await redis.expire(`campaign:${campaignId}:recipients`, 90 * 24 * 60 * 60)
}

// ============================================
// External API calls
// ============================================

// Pipedrive custom field for Lead Source tracking
const PIPEDRIVE_LEAD_SOURCE_FIELD = '99d8fd03cd23f075951af87ddaf2b1b6aa8fed1f'

async function createPipedriveContact(contact: NormalizedContact, campaignName: string): Promise<{ id: number; created: boolean }> {
  const apiKey = process.env.PIPEDRIVE_API_KEY
  const domain = process.env.PIPEDRIVE_COMPANY_DOMAIN

  if (!apiKey || !domain) {
    throw new Error(`Pipedrive credentials not configured: apiKey=${!!apiKey}, domain=${!!domain}`)
  }

  // Search for existing - use api.pipedrive.com (not ${domain}.pipedrive.com)
  let searchRes: Response
  try {
    searchRes = await fetch(
      `https://api.pipedrive.com/v1/persons/search?term=${encodeURIComponent(contact.phone)}&fields=phone&api_token=${apiKey}`
    )
  } catch (fetchError) {
    console.error('[PIPEDRIVE] Search fetch error:', fetchError)
    throw new Error(`Pipedrive search fetch failed: ${(fetchError as Error).message}`)
  }

  if (!searchRes.ok) {
    const errorText = await searchRes.text()
    throw new Error(`Pipedrive search failed: ${searchRes.status} - ${errorText}`)
  }

  const searchData = await searchRes.json()

  if (searchData.data?.items?.length > 0) {
    return { id: searchData.data.items[0].item.id, created: false }
  }

  // Create new - use api.pipedrive.com (not ${domain}.pipedrive.com)
  let createRes: Response
  try {
    createRes = await fetch(
      `https://api.pipedrive.com/v1/persons?api_token=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: `${contact.firstName} ${contact.lastName || ''}`.trim(),
          phone: [{ value: contact.phone, primary: true, label: 'mobile' }],
          email: contact.email ? [{ value: contact.email, primary: true, label: 'work' }] : undefined,
          visible_to: 3,
          [PIPEDRIVE_LEAD_SOURCE_FIELD]: `Campaign: ${campaignName}`,
        }),
      }
    )
  } catch (fetchError) {
    throw new Error(`Pipedrive create fetch failed: ${(fetchError as Error).message}`)
  }

  if (!createRes.ok) {
    const errorText = await createRes.text()
    throw new Error(`Pipedrive create failed: ${createRes.status} - ${errorText}`)
  }

  const createData = await createRes.json()

  if (!createData.data?.id) {
    throw new Error(`Pipedrive create returned invalid response: ${JSON.stringify(createData)}`)
  }

  return { id: createData.data.id, created: true }
}

// ============================================
// Main handler
// ============================================

export async function POST(request: Request) {
  try {
    const redis = getRedis()
    const qstash = getQstash()

    // Fetch global settings
    const settingsData = await redis.get('settings:global')
    // Handle both string and auto-parsed object from Upstash
    const settings = settingsData
      ? (typeof settingsData === 'string' ? JSON.parse(settingsData) : settingsData)
      : { campaign: { optOutFooter: 'Reply STOP to opt out', throttleSeconds: 45, dailySendLimit: 125, skipWeekends: true, defaultStartHour: 9 } }
    const optOutFooter = settings.campaign?.optOutFooter || ''
    const throttleSeconds = settings.campaign?.throttleSeconds || 45
    const dailySendLimit = settings.campaign?.dailySendLimit || 125
    const skipWeekends = settings.campaign?.skipWeekends ?? true
    const defaultStartHour = settings.campaign?.defaultStartHour ?? 9

    const body: CreateCampaignRequest = await request.json()
    const { name, csvData, message, messageA, messageB, dryRun, skipDedup, scheduledAt, followUp } = body

    // Calculate base delay for scheduled campaigns
    let baseDelay = 0
    if (scheduledAt && !dryRun) {
      const scheduledTime = new Date(scheduledAt).getTime()
      const now = Date.now()
      baseDelay = Math.max(0, Math.floor((scheduledTime - now) / 1000))
    }

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
    console.log(`[CAMPAIGN CREATE v2] Parsed CSV: ${contacts.length} contacts, parseStats:`, JSON.stringify(parseStats))
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

    const campaignId = `campaign-${name.toLowerCase().replace(/[^a-z0-9-]/g, '-')}-${Date.now()}`
    const defaultMessage = message || messageA!

    // Determine if this is a multi-day campaign
    const isMultiDay = contacts.length > dailySendLimit
    const totalDays = isMultiDay ? Math.ceil(contacts.length / dailySendLimit) : 1

    // For multi-day campaigns, only process the first batch
    const batchContacts = isMultiDay ? contacts.slice(0, dailySendLimit) : contacts
    const remainingContacts = isMultiDay ? contacts.slice(dailySendLimit) : []

    // Calculate next batch time if multi-day
    let nextBatchTime: Date | undefined
    if (isMultiDay && !dryRun) {
      nextBatchTime = calculateNextBatchTime(defaultStartHour, skipWeekends)
    }

    if (!dryRun) {
      const multiDayConfig: MultiDayConfig | undefined = isMultiDay ? {
        dailyLimit: dailySendLimit,
        skipWeekends,
        startHour: defaultStartHour,
        totalContacts: contacts.length,
        currentDay: 1,
        nextBatchAt: nextBatchTime?.toISOString(),
      } : undefined

      await createCampaignRecord(redis, campaignId, name, defaultMessage, variants, followUp, multiDayConfig)
      await incrementStats(redis, campaignId, { total: contacts.length })

      // Store remaining contacts for later batches
      if (remainingContacts.length > 0) {
        await storePendingContacts(redis, campaignId, remainingContacts)
      }
    }

    // Always use production URL - VERCEL_URL returns deployment-specific URLs which can cause signature verification issues
    const callbackUrl = 'https://aac-middleware.vercel.app/api/campaign/send'
    const batchCallbackUrl = 'https://aac-middleware.vercel.app/api/campaign/process-batch'

    const results = {
      campaignId, parseStats, processed: 0, queued: 0, skipped: 0, pipedriveCreated: 0,
      variantCounts: { A: 0, B: 0 } as Record<string, number>,
      preview: [] as Array<{ phone: string; name: string; city: string; message: string; variant?: string }>,
      isMultiDay,
      totalDays,
      dailyLimit: dailySendLimit,
      batchSize: batchContacts.length,
      remainingContacts: remainingContacts.length,
      nextBatchAt: nextBatchTime?.toISOString(),
    }

    let queueIndex = 0

    // Process only the current batch (first day's contacts)
    // Note: OpenPhone dedup check was removed - it's now done ONLY in prefilter
    // This prevents the "2 clean but 2 skipped" inconsistency where phones pass
    // prefilter but get caught here due to API flakiness during prefilter
    console.log(`[CAMPAIGN CREATE v2] Processing ${batchContacts.length} contacts, dryRun=${dryRun}, skipDedup=${skipDedup}`)
    for (const contact of batchContacts) {
      results.processed++
      console.log(`[CAMPAIGN CREATE v2] Processing contact ${results.processed}: ${contact.phone}`)

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

      let personalizedMessage = personalizeMessage(messageTemplate, contact)

      // Append opt-out footer if configured
      if (optOutFooter) {
        personalizedMessage = `${personalizedMessage}\n\n${optOutFooter}`
      }

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

      // Queue message via QStash with configurable throttle
      // Add base delay for scheduled campaigns
      const delay = baseDelay + Math.floor(queueIndex * throttleSeconds)
      try {
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
      } catch (qstashError) {
        throw new Error(`QStash publish failed: ${(qstashError as Error).message}`)
      }
      await incrementStats(redis, campaignId, { queued: 1 })

      // Track recipient for follow-up processing
      if (followUp) {
        await trackRecipient(redis, campaignId, contact.phone, contact, variantId)
      }

      results.queued++
      queueIndex++
    }

    if (!dryRun) {
      await updateStatus(redis, campaignId, 'running')

      // Schedule next batch if multi-day campaign
      if (isMultiDay && remainingContacts.length > 0 && nextBatchTime) {
        const delaySeconds = Math.max(0, Math.floor((nextBatchTime.getTime() - Date.now()) / 1000))
        await qstash.publishJSON({
          url: batchCallbackUrl,
          delay: delaySeconds,
          body: {
            campaignId,
            optOutFooter,
            throttleSeconds,
            skipDedup,
          },
        })
      }
    }

    const response = {
      success: true,
      dryRun: !!dryRun,
      ...results,
      throttleSeconds,
      scheduledAt: scheduledAt || null,
      estimatedMinutes: Math.ceil((results.queued * throttleSeconds) / 60),
      estimatedTotalDays: isMultiDay ? totalDays : 1,
    }
    console.log(`[CAMPAIGN CREATE v2] FINAL RESPONSE:`, JSON.stringify(response, null, 2))
    return NextResponse.json(response)
  } catch (error) {
    console.error('Campaign create error:', error)
    // Ensure we return a proper error message string
    let errorMessage = 'Unknown error occurred'
    if (error instanceof Error) {
      errorMessage = error.message
    } else if (typeof error === 'string') {
      errorMessage = error
    } else if (error && typeof error === 'object') {
      errorMessage = JSON.stringify(error)
    }
    return NextResponse.json({ error: errorMessage }, { status: 500 })
  }
}
