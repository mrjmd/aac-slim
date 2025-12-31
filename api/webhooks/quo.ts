/**
 * Quo (OpenPhone) Webhook Handler
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

import type { VercelRequest, VercelResponse } from '@vercel/node';
import crypto from 'crypto';
import { getEnv } from '../../src/lib/env.js';
import { logger } from '../../src/lib/logger.js';
import { normalizePhone } from '../../src/lib/phone.js';
import {
  markEventProcessed,
  getPipedriveIdFromPhone,
  storePhoneMapping,
  findCampaignForPhone,
  incrementCampaignStats,
  incrementVariantStats,
  addOptOut,
  isOptOutMessage,
  trackWebhookProcessed,
  logHealthError,
} from '../../src/lib/redis.js';
import { searchPersonByPhone, createPerson, logActivity, updatePersonIncremental } from '../../src/clients/pipedrive.js';
import { extractEntities, hasUsefulEntities } from '../../src/clients/gemini.js';

const log = logger.child({ handler: 'quo-webhook' });

// Quo webhook event types we handle
type QuoEventType = 'call.completed' | 'call.ringing' | 'message.received' | 'message.delivered' | 'call.transcript.completed';

// Quo webhook payload structure
interface QuoWebhookPayload {
  id: string; // Event ID for deduplication
  type: QuoEventType;
  createdAt: string;
  data: {
    // For calls
    object?: 'call';
    id?: string;
    direction?: 'incoming' | 'outgoing';
    from?: string; // E.164 phone
    to?: string; // E.164 phone
    status?: 'completed' | 'missed' | 'voicemail';
    duration?: number; // seconds
    recordingUrl?: string;
    voicemailUrl?: string;

    // For messages
    conversationId?: string;
    phoneNumber?: string; // Our number
    body?: string;
    participants?: Array<{
      phoneNumber: string;
      name?: string;
    }>;
  };
}

/**
 * Verify webhook signature from Quo/OpenPhone
 * https://www.openphone.com/docs/webhooks#webhook-verification
 */
function verifySignature(
  payload: string,
  signature: string | undefined,
  secret: string
): boolean {
  if (!signature) return false;

  const expected = crypto
    .createHmac('sha256', secret)
    .update(payload)
    .digest('hex');

  try {
    return crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expected)
    );
  } catch {
    return false;
  }
}

// Minimum message length for AI processing (skip trivial messages)
const MIN_MESSAGE_LENGTH = 10;

/**
 * Check if a message should be processed by AI for entity extraction
 * Rules: Only inbound messages/transcripts with sufficient content
 */
function shouldProcessForAI(payload: QuoWebhookPayload): boolean {
  // Only process inbound messages and transcripts
  if (payload.type === 'message.delivered') return false; // Outbound SMS
  if (payload.type === 'call.completed') return false; // Call without transcript

  // For transcripts, check direction
  if (payload.type === 'call.transcript.completed') {
    if (payload.data.direction === 'outgoing') return false;
  }

  // Get the text content
  const text = payload.data.body || '';

  // Skip trivial messages
  if (text.length < MIN_MESSAGE_LENGTH) return false;

  return true;
}

/**
 * Extract the remote (external) phone number from the event
 * For incoming: it's the "from" number
 * For outgoing: it's the "to" number
 */
function extractRemotePhone(payload: QuoWebhookPayload): string | null {
  const { type, data } = payload;

  if (type === 'call.completed' || type === 'call.ringing') {
    // For calls, use from/to based on direction
    if (data.direction === 'incoming') {
      return data.from || null;
    } else {
      return data.to || null;
    }
  }

  if (type === 'message.received' || type === 'message.delivered') {
    // For messages, find the participant that isn't our number
    const ourNumber = data.phoneNumber;
    const participant = data.participants?.find(
      (p) => p.phoneNumber !== ourNumber
    );
    return participant?.phoneNumber || null;
  }

  if (type === 'call.transcript.completed') {
    // Transcripts are associated with calls, use same logic as calls
    if (data.direction === 'incoming') {
      return data.from || null;
    } else {
      return data.to || null;
    }
  }

  return null;
}

/**
 * Main webhook handler
 */
export default async function handler(
  req: VercelRequest,
  res: VercelResponse
): Promise<void> {
  // Only accept POST
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const env = getEnv();

  // ============================================
  // SIGNATURE VERIFICATION
  // ============================================
  const signature = req.headers['openphone-signature'] as string | undefined;
  const rawBody = JSON.stringify(req.body);

  if (!verifySignature(rawBody, signature, env.quo.webhookSecret)) {
    log.warn('Invalid webhook signature');
    res.status(401).json({ error: 'Invalid signature' });
    return;
  }

  const payload = req.body as QuoWebhookPayload;

  // Basic validation
  if (!payload?.id || !payload?.type) {
    log.warn('Invalid payload', { hasBody: !!req.body });
    res.status(400).json({ error: 'Invalid payload' });
    return;
  }

  log.info('Received Quo webhook', {
    eventId: payload.id,
    type: payload.type,
  });

  // ============================================
  // FILTER EVENTS
  // ============================================
  // Process calls, messages (both directions), and transcripts
  const allowedEvents: QuoEventType[] = ['call.completed', 'message.received', 'message.delivered', 'call.transcript.completed'];
  if (!allowedEvents.includes(payload.type)) {
    log.debug('Ignoring event type', { type: payload.type });
    res.status(200).json({ status: 'ignored', reason: 'event_type' });
    return;
  }

  try {
    // ============================================
    // DEDUPLICATION
    // ============================================
    const isNew = await markEventProcessed('quo', payload.id);
    if (!isNew) {
      log.info('Duplicate event ignored', { eventId: payload.id });
      res.status(200).json({ status: 'ignored', reason: 'duplicate' });
      return;
    }

    // ============================================
    // EXTRACT & VALIDATE PHONE
    // ============================================
    const rawPhone = extractRemotePhone(payload);
    if (!rawPhone) {
      log.warn('Could not extract remote phone', { eventId: payload.id });
      res.status(200).json({ status: 'skipped', reason: 'no_phone' });
      return;
    }

    const e164Phone = normalizePhone(rawPhone);
    if (!e164Phone) {
      log.warn('Invalid phone number', { rawPhone });
      res.status(200).json({ status: 'skipped', reason: 'invalid_phone' });
      return;
    }

    // ============================================
    // FIND OR CREATE PIPEDRIVE PERSON
    // ============================================
    let pipedrivePersonId: number | null = null;

    // Check cache first
    const cachedId = await getPipedriveIdFromPhone(e164Phone);
    if (cachedId) {
      pipedrivePersonId = parseInt(cachedId, 10);
      log.debug('Found person ID in cache', { phone: e164Phone, personId: pipedrivePersonId });
    }

    // If not cached, search Pipedrive
    if (!pipedrivePersonId) {
      const existingPerson = await searchPersonByPhone(e164Phone);

      if (existingPerson) {
        pipedrivePersonId = existingPerson.id;
        await storePhoneMapping(e164Phone, String(pipedrivePersonId));
        log.info('Found existing Pipedrive person', { phone: e164Phone, personId: pipedrivePersonId });
      }
    }

    // If still not found, create "Unknown Lead"
    if (!pipedrivePersonId) {
      log.info('Creating Unknown Lead', { phone: e164Phone });

      const newPerson = await createPerson(
        `Unknown Lead ${e164Phone}`,
        e164Phone
      );

      pipedrivePersonId = newPerson.id;
      await storePhoneMapping(e164Phone, String(pipedrivePersonId));

      log.info('Created Unknown Lead', { phone: e164Phone, personId: pipedrivePersonId });
    }

    // ============================================
    // LOG ACTIVITY
    // ============================================
    if (payload.type === 'call.completed') {
      const direction = payload.data.direction === 'incoming' ? 'Inbound' : 'Outbound';
      const duration = payload.data.duration || 0;
      const status = payload.data.status || 'completed';

      let note = `${direction} call - ${status}`;
      if (payload.data.recordingUrl) {
        note += `\n\nRecording: ${payload.data.recordingUrl}`;
      }
      if (payload.data.voicemailUrl) {
        note += `\n\nVoicemail: ${payload.data.voicemailUrl}`;
      }

      await logActivity(pipedrivePersonId, 'call', {
        subject: `${direction} Call (${Math.round(duration / 60)}m ${duration % 60}s)`,
        note,
        duration,
      });

      log.info('Logged call activity', { personId: pipedrivePersonId, duration });
    }

    if (payload.type === 'message.received' || payload.type === 'message.delivered') {
      const messageBody = payload.data.body || '(no content)';
      const truncatedBody = messageBody.length > 100
        ? messageBody.substring(0, 100) + '...'
        : messageBody;

      const direction = payload.type === 'message.received' ? 'Received' : 'Sent';

      await logActivity(pipedrivePersonId, 'sms', {
        subject: `SMS ${direction}: "${truncatedBody}"`,
        note: `Full message:\n\n${messageBody}`,
      });

      log.info('Logged SMS activity', { personId: pipedrivePersonId, direction });
    }

    if (payload.type === 'call.transcript.completed') {
      const transcript = payload.data.body || '(no transcript)';

      await logActivity(pipedrivePersonId, 'call', {
        subject: 'Call Transcript Available',
        note: `Transcript:\n\n${transcript}`,
      });

      log.info('Logged transcript activity', { personId: pipedrivePersonId });
    }

    // ============================================
    // CAMPAIGN RESPONSE TRACKING (Module 3)
    // ============================================
    if (payload.type === 'message.received') {
      const messageBody = payload.data.body || '';

      // Check if this phone is part of any active campaign
      const campaignResult = await findCampaignForPhone(e164Phone);

      if (campaignResult) {
        const { campaign, variant } = campaignResult;

        log.info('Inbound message from campaign contact', {
          phone: e164Phone,
          campaignId: campaign.id,
          variant,
        });

        // Check for opt-out first
        if (isOptOutMessage(messageBody)) {
          log.info('Opt-out detected', { phone: e164Phone, campaignId: campaign.id });

          // Add to global opt-out list
          await addOptOut(e164Phone);

          // Update campaign stats
          await incrementCampaignStats(campaign.id, { optOuts: 1 });

          // Update variant stats if applicable
          if (variant) {
            await incrementVariantStats(campaign.id, variant, { optOuts: 1 });
          }
        } else {
          // Track as a response
          await incrementCampaignStats(campaign.id, { responses: 1 });

          // Update variant stats if applicable
          if (variant) {
            await incrementVariantStats(campaign.id, variant, { responses: 1 });
          }
        }
      }
    }

    // ============================================
    // AI ENTITY EXTRACTION (Module 1.3)
    // ============================================
    if (shouldProcessForAI(payload)) {
      const textContent = payload.data.body || '';
      log.info('Processing for AI entity extraction', {
        personId: pipedrivePersonId,
        type: payload.type,
        textLength: textContent.length,
      });

      try {
        const entities = await extractEntities(textContent);

        if (hasUsefulEntities(entities)) {
          // Build name from extracted entities
          let extractedName: string | undefined;
          if (entities!.fullName) {
            extractedName = entities!.fullName;
          } else if (entities!.firstName && entities!.lastName) {
            extractedName = `${entities!.firstName} ${entities!.lastName}`;
          } else if (entities!.firstName) {
            extractedName = entities!.firstName;
          } else if (entities!.lastName) {
            extractedName = entities!.lastName;
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
          });

          if (updateResult.updated) {
            log.info('AI extracted and updated contact', {
              personId: pipedrivePersonId,
              fields: updateResult.fields,
              confidence: entities!.confidence,
            });
          }
        }
      } catch (error) {
        // Don't fail the webhook if AI extraction fails
        log.error('AI entity extraction failed', error as Error, {
          personId: pipedrivePersonId,
        });
      }
    }

    // Track successful processing for health dashboard
    await trackWebhookProcessed('quo');

    res.status(200).json({
      status: 'processed',
      pipedrivePersonId,
      eventType: payload.type,
    });
  } catch (error) {
    log.error('Webhook processing failed', error as Error, { eventId: payload.id });

    // Log error for health dashboard
    await logHealthError('quo', (error as Error).message, payload.id);

    // Return 200 to acknowledge receipt
    res.status(200).json({
      status: 'error',
      message: 'Processing failed, logged for investigation',
    });
  }
}
