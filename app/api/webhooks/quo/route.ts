/**
 * Quo (OpenPhone) Webhook Handler (App Router)
 *
 * Triggers: call.completed, message.received
 * Actions:
 *   1. Find or create Pipedrive contact for the phone number
 *   2. Log the call/SMS as an activity on the contact
 *
 * Note: Creating an "Unknown Lead" in Pipedrive will trigger the
 * Pipedrive webhook, which syncs back to Quo. The Pipedrive webhook
 * uses loop prevention (system user ID) to avoid infinite loops.
 */

import { NextResponse } from 'next/server'
import crypto from 'crypto'
import { getEnv } from '@/lib/env'
import { logger } from '@/lib/logger'
import { normalizePhone } from '@/lib/phone'
import {
  markEventProcessed,
  getPipedriveIdFromPhone,
  storePhoneMapping,
  findCampaignForPhone,
  incrementCampaignStats,
  incrementVariantStats,
  isOptOutMessage,
  markRecipientResponded,
  trackWebhookProcessed,
  logHealthError,
  getRedis,
} from '@/lib/redis'
import { searchPersonByPhone, createPerson, logActivity, updatePersonIncremental } from '@/clients/pipedrive'
import { extractEntities, hasUsefulEntities } from '@/clients/gemini'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const log = logger.child({ handler: 'quo-webhook' })

// Quo webhook event types we handle
type QuoEventType = 'call.completed' | 'call.ringing' | 'message.received' | 'message.delivered' | 'call.transcript.completed'

// Dialogue entry in a call transcript
interface TranscriptDialogueEntry {
  start: number
  end: number
  content: string
  identifier: string // Phone number E.164
  userId?: string // Present if from internal user, absent if from external caller
}

// Quo webhook payload structure (API v3)
// Wrapped in "object" with nested "data.object"
interface QuoWebhookPayload {
  object: {
    id: string // Event ID for deduplication
    type: QuoEventType
    createdAt: string
    apiVersion: string
    data: {
      object: {
        // Common fields
        id: string
        object: 'message' | 'call' | 'callTranscript'
        createdAt: string

        // For messages and calls
        direction?: 'incoming' | 'outgoing'
        from?: string // E.164 phone
        to?: string // E.164 phone
        userId?: string
        phoneNumberId?: string
        conversationId?: string

        // For messages
        body?: string
        media?: Array<{ url: string; type: string }>
        status?: 'received' | 'sent' | 'delivered' | 'queued'

        // For calls
        duration?: number // seconds
        recordingUrl?: string
        voicemailUrl?: string
        answeredAt?: string

        // For transcripts
        callId?: string // Reference to original call
        dialogue?: TranscriptDialogueEntry[]
      }
      deepLink?: string
    }
  }
}

/**
 * Verify webhook signature from Quo/OpenPhone
 *
 * Header format: hmac;1;<timestamp>;<base64-signature>
 * Signed data: <timestamp>.<json-payload>
 * Secret: base64-encoded, must decode to binary for HMAC
 */
function verifySignature(
  payload: string,
  signatureHeader: string | undefined,
  secret: string
): boolean {
  if (!signatureHeader) return false

  // Parse header: hmac;1;timestamp;signature
  const parts = signatureHeader.split(';')
  if (parts.length !== 4) {
    log.warn('Invalid signature header format', { parts: parts.length })
    return false
  }

  const [scheme, version, timestamp, providedSignature] = parts

  if (scheme !== 'hmac' || version !== '1') {
    log.warn('Unsupported signature scheme/version', { scheme, version })
    return false
  }

  // Prepare signed data: timestamp.payload
  const signedData = `${timestamp}.${payload}`

  // Decode secret from base64 to binary
  const signingKey = Buffer.from(secret, 'base64')

  // Compute HMAC-SHA256 and encode as base64
  const computedSignature = crypto
    .createHmac('sha256', signingKey)
    .update(signedData)
    .digest('base64')

  try {
    return crypto.timingSafeEqual(
      Buffer.from(providedSignature),
      Buffer.from(computedSignature)
    )
  } catch {
    return false
  }
}

// Minimum message length for AI processing (skip trivial messages)
const MIN_MESSAGE_LENGTH = 10

/**
 * Extract text content from event data for AI processing
 * For messages: returns body
 * For transcripts: returns formatted dialogue from external caller only
 */
function extractTextForAI(eventData: QuoWebhookPayload['object']['data']['object']): string {
  // For transcripts, extract just the external caller's dialogue
  if (eventData.object === 'callTranscript' && eventData.dialogue) {
    // Get only entries from external caller (no userId)
    const externalDialogue = eventData.dialogue
      .filter(entry => !entry.userId)
      .map(entry => entry.content)
      .join(' ')
    return externalDialogue
  }

  // For messages, use body
  return eventData.body || ''
}

/**
 * Check if a message should be processed by AI for entity extraction
 * Rules: Only inbound messages/transcripts with sufficient content
 */
function shouldProcessForAI(
  eventType: QuoEventType,
  eventData: QuoWebhookPayload['object']['data']['object']
): boolean {
  // Only process inbound messages and transcripts
  if (eventType === 'message.delivered') return false // Outbound SMS
  if (eventType === 'call.completed') return false // Call without transcript

  // For transcripts, always process (external caller initiated)
  if (eventType === 'call.transcript.completed') {
    // Check if we have dialogue from external caller
    if (eventData.dialogue) {
      const externalDialogue = eventData.dialogue.filter(entry => !entry.userId)
      if (externalDialogue.length === 0) return false
    }
  }

  // Get the text content
  const text = extractTextForAI(eventData)

  // Skip trivial content
  if (text.length < MIN_MESSAGE_LENGTH) return false

  return true
}

/**
 * Extract the remote (external) phone number from the event data
 * For incoming: it's the "from" number
 * For outgoing: it's the "to" number
 * For transcripts: find dialogue entries without userId (external caller)
 */
function extractRemotePhone(eventData: QuoWebhookPayload['object']['data']['object']): string | null {
  // For transcripts, extract from dialogue entries
  if (eventData.object === 'callTranscript' && eventData.dialogue) {
    // Find an entry from the external caller (no userId = not internal user)
    const externalEntry = eventData.dialogue.find(entry => !entry.userId)
    if (externalEntry) {
      return externalEntry.identifier || null
    }
    return null
  }

  // For messages and calls, use from/to based on direction
  if (eventData.direction === 'incoming') {
    return eventData.from || null
  } else {
    return eventData.to || null
  }
}

/**
 * Main webhook handler
 */
export async function POST(request: Request) {
  const env = getEnv()

  // ============================================
  // SIGNATURE VERIFICATION
  // ============================================
  // Get raw body for signature verification
  const rawBody = await request.text()
  const signature = request.headers.get('openphone-signature') || undefined

  if (!verifySignature(rawBody, signature, env.quo.webhookSecret)) {
    log.warn('Invalid webhook signature')
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }

  let payload: QuoWebhookPayload
  try {
    payload = JSON.parse(rawBody)
  } catch {
    log.warn('Invalid JSON payload')
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  // Handle both wrapped and unwrapped payload formats
  // Wrapped: { object: { id, type, data: { object: {...} } } }
  // Unwrapped: { id, type, data: { object: {...} } }
  const rawPayload = payload as unknown as Record<string, unknown>

  // Detect format and normalize
  let event: QuoWebhookPayload['object']
  if (rawPayload?.object && typeof rawPayload.object === 'object') {
    // Wrapped format
    event = rawPayload.object as QuoWebhookPayload['object']
  } else if (rawPayload?.id && rawPayload?.type) {
    // Unwrapped format - payload IS the event
    event = rawPayload as unknown as QuoWebhookPayload['object']
  } else {
    log.warn('Invalid payload structure', {
      keys: Object.keys(rawPayload || {}),
    })
    return NextResponse.json({ error: 'Invalid payload' }, { status: 400 })
  }

  // Validate event has required fields
  if (!event?.id || !event?.type || !event?.data?.object) {
    log.warn('Invalid event structure', {
      hasId: !!event?.id,
      hasType: !!event?.type,
      hasData: !!event?.data,
    })
    return NextResponse.json({ error: 'Invalid payload' }, { status: 400 })
  }

  const eventData = event.data.object

  log.info('Received Quo webhook', {
    eventId: event.id,
    type: event.type,
  })

  // ============================================
  // FILTER EVENTS
  // ============================================
  // Process calls, messages (both directions), and transcripts
  const allowedEvents: QuoEventType[] = ['call.completed', 'message.received', 'message.delivered', 'call.transcript.completed']
  if (!allowedEvents.includes(event.type)) {
    log.debug('Ignoring event type', { type: event.type })
    return NextResponse.json({ status: 'ignored', reason: 'event_type' })
  }

  try {
    // ============================================
    // DEDUPLICATION
    // ============================================
    const isNew = await markEventProcessed('quo', event.id)
    if (!isNew) {
      log.info('Duplicate event ignored', { eventId: event.id })
      return NextResponse.json({ status: 'ignored', reason: 'duplicate' })
    }

    // ============================================
    // EXTRACT & VALIDATE PHONE
    // ============================================
    const rawPhone = extractRemotePhone(eventData)
    if (!rawPhone) {
      log.warn('Could not extract remote phone', { eventId: event.id })
      return NextResponse.json({ status: 'skipped', reason: 'no_phone' })
    }

    const e164Phone = normalizePhone(rawPhone)
    if (!e164Phone) {
      log.warn('Invalid phone number', { rawPhone })
      return NextResponse.json({ status: 'skipped', reason: 'invalid_phone' })
    }

    // ============================================
    // FIND OR CREATE PIPEDRIVE PERSON
    // ============================================
    let pipedrivePersonId: number | null = null

    // Check cache first
    const cachedId = await getPipedriveIdFromPhone(e164Phone)
    if (cachedId) {
      pipedrivePersonId = parseInt(cachedId, 10)
      log.debug('Found person ID in cache', { phone: e164Phone, personId: pipedrivePersonId })
    }

    // If not cached, search Pipedrive
    if (!pipedrivePersonId) {
      const existingPerson = await searchPersonByPhone(e164Phone)

      if (existingPerson) {
        pipedrivePersonId = existingPerson.id
        await storePhoneMapping(e164Phone, String(pipedrivePersonId))
        log.info('Found existing Pipedrive person', { phone: e164Phone, personId: pipedrivePersonId })
      }
    }

    // If still not found, create "Unknown Lead"
    if (!pipedrivePersonId) {
      log.info('Creating Unknown Lead', { phone: e164Phone })

      const newPerson = await createPerson(
        `Unknown Lead ${e164Phone}`,
        e164Phone
      )

      pipedrivePersonId = newPerson.id
      await storePhoneMapping(e164Phone, String(pipedrivePersonId))

      log.info('Created Unknown Lead', { phone: e164Phone, personId: pipedrivePersonId })
    }

    // ============================================
    // LOG ACTIVITY
    // ============================================
    if (event.type === 'call.completed') {
      const direction = eventData.direction === 'incoming' ? 'Inbound' : 'Outbound'
      const duration = eventData.duration || 0

      let note = `${direction} call`
      if (eventData.recordingUrl) {
        note += `\n\nRecording: ${eventData.recordingUrl}`
      }
      if (eventData.voicemailUrl) {
        note += `\n\nVoicemail: ${eventData.voicemailUrl}`
      }

      await logActivity(pipedrivePersonId, 'call', {
        subject: `${direction} Call (${Math.round(duration / 60)}m ${duration % 60}s)`,
        note,
        duration,
      })

      log.info('Logged call activity', { personId: pipedrivePersonId, duration })
    }

    if (event.type === 'message.received' || event.type === 'message.delivered') {
      const messageBody = eventData.body || '(no content)'
      const truncatedBody = messageBody.length > 100
        ? messageBody.substring(0, 100) + '...'
        : messageBody

      const direction = event.type === 'message.received' ? 'Received' : 'Sent'

      await logActivity(pipedrivePersonId, 'sms', {
        subject: `SMS ${direction}: "${truncatedBody}"`,
        note: `Full message:\n\n${messageBody}`,
      })

      log.info('Logged SMS activity', { personId: pipedrivePersonId, direction })
    }

    if (event.type === 'call.transcript.completed') {
      // Format transcript dialogue for activity note
      let transcript = '(no transcript)'
      if (eventData.dialogue && eventData.dialogue.length > 0) {
        transcript = eventData.dialogue
          .map(entry => {
            const speaker = entry.userId ? 'AAC' : 'Caller'
            return `${speaker}: ${entry.content}`
          })
          .join('\n')
      }

      await logActivity(pipedrivePersonId, 'call', {
        subject: 'Call Transcript Available',
        note: `Transcript:\n\n${transcript}`,
      })

      log.info('Logged transcript activity', { personId: pipedrivePersonId })
    }

    // ============================================
    // CAMPAIGN RESPONSE TRACKING (Module 3)
    // ============================================
    if (event.type === 'message.received') {
      const messageBody = eventData.body || ''

      // Check for opt-out FIRST - applies to anyone we've ever messaged
      // This must happen before campaign check because campaigns may be completed
      if (isOptOutMessage(messageBody)) {
        // Check if we've ever messaged this phone (from any campaign)
        const redis = getRedis()
        const normalizedPhone = e164Phone.replace(/\D/g, '').slice(-10)
        const wasMessaged = await redis.sismember('suppression:ever-messaged', normalizedPhone)

        if (wasMessaged === 1) {
          log.info('Opt-out detected from previously messaged phone', { phone: e164Phone })

          // Add to global opt-out list (using 10-digit format for consistency)
          await redis.sadd('optouts:phones', normalizedPhone)

          // Mark as responded to prevent follow-ups
          await markRecipientResponded(e164Phone)

          // Try to update campaign stats if campaign is still active
          const campaignResult = await findCampaignForPhone(e164Phone)
          if (campaignResult) {
            const { campaign, variant } = campaignResult
            await incrementCampaignStats(campaign.id, { optOuts: 1 })
            if (variant) {
              await incrementVariantStats(campaign.id, variant, { optOuts: 1 })
            }
          }
        }
      } else {
        // Not an opt-out - check if this phone is part of any active campaign
        const campaignResult = await findCampaignForPhone(e164Phone)

        if (campaignResult) {
          const { campaign, variant } = campaignResult

          log.info('Inbound message from campaign contact', {
            phone: e164Phone,
            campaignId: campaign.id,
            variant,
          })

          // Mark recipient as responded (prevents follow-up messages)
          await markRecipientResponded(e164Phone)

          // Track as a response
          await incrementCampaignStats(campaign.id, { responses: 1 })

          // Update variant stats if applicable
          if (variant) {
            await incrementVariantStats(campaign.id, variant, { responses: 1 })
          }
        }
      }
    }

    // ============================================
    // AI ENTITY EXTRACTION (Module 1.3)
    // ============================================
    if (shouldProcessForAI(event.type, eventData)) {
      const textContent = extractTextForAI(eventData)
      log.info('Processing for AI entity extraction', {
        personId: pipedrivePersonId,
        type: event.type,
        textLength: textContent.length,
      })

      try {
        const entities = await extractEntities(textContent)

        if (hasUsefulEntities(entities)) {
          // Build name from extracted entities
          let extractedName: string | undefined
          if (entities!.fullName) {
            extractedName = entities!.fullName
          } else if (entities!.firstName && entities!.lastName) {
            extractedName = `${entities!.firstName} ${entities!.lastName}`
          } else if (entities!.firstName) {
            extractedName = entities!.firstName
          } else if (entities!.lastName) {
            extractedName = entities!.lastName
          }

          // Incrementally update Pipedrive (only add new fields)
          const updateResult = await updatePersonIncremental(pipedrivePersonId, {
            name: extractedName,
            phone: e164Phone,
            email: entities!.email || undefined,
            address: entities!.streetAddress || undefined,
            city: entities!.city || undefined,
            state: entities!.state || undefined,
            zipCode: entities!.zipCode || undefined,
          })

          if (updateResult.updated) {
            log.info('AI extracted and updated contact', {
              personId: pipedrivePersonId,
              fields: updateResult.fields,
              confidence: entities!.confidence,
            })
          }
        }
      } catch (error) {
        // Don't fail the webhook if AI extraction fails
        log.error('AI entity extraction failed', error as Error, {
          personId: pipedrivePersonId,
        })
      }
    }

    // Track successful processing for health dashboard
    await trackWebhookProcessed('quo')

    return NextResponse.json({
      status: 'processed',
      pipedrivePersonId,
      eventType: event.type,
    })
  } catch (error) {
    log.error('Webhook processing failed', error as Error, { eventId: event.id })

    // Log error for health dashboard
    await logHealthError('quo', (error as Error).message, event.id)

    // Return 200 to acknowledge receipt
    return NextResponse.json({
      status: 'error',
      message: 'Processing failed, logged for investigation',
    })
  }
}
