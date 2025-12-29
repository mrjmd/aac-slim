/**
 * Google Ads Lead Form Webhook Handler
 *
 * Triggers: Lead form submission from Google Ads
 * Actions:
 *   1. Find or create Pipedrive person
 *   2. Send SMS alert to sales team
 *   3. Create Pipedrive task for follow-up
 *
 * Docs: https://developers.google.com/google-ads/webhook/docs/implementation
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getEnv } from '../../src/lib/env.js';
import { logger } from '../../src/lib/logger.js';
import { normalizePhone } from '../../src/lib/phone.js';
import { markEventProcessed, storePhoneMapping } from '../../src/lib/redis.js';
import { searchPersonByPhone, createPerson, createTask, updatePerson } from '../../src/clients/pipedrive.js';
import { sendMessage } from '../../src/clients/quo.js';

const log = logger.child({ handler: 'google-ads-webhook' });

// Google Ads Lead Form webhook payload structure
interface GoogleAdsLeadPayload {
  lead_id: string;
  user_column_data: Array<{
    column_id: string;
    column_name?: string;
    string_value: string;
  }>;
  api_version?: string;
  form_id: number;
  campaign_id: number;
  adgroup_id?: number;
  creative_id?: number;
  google_key: string;
  is_test?: boolean;
  gcl_id?: string;
  lead_submit_time?: string;
}

// Standard Google Ads column IDs
const COLUMN_IDS = {
  FULL_NAME: 'FULL_NAME',
  FIRST_NAME: 'FIRST_NAME',
  LAST_NAME: 'LAST_NAME',
  PHONE_NUMBER: 'PHONE_NUMBER',
  EMAIL: 'EMAIL',
  CITY: 'CITY',
  POSTAL_CODE: 'POSTAL_CODE',
} as const;

/**
 * Extract a field value from user_column_data
 */
function getFieldValue(
  data: GoogleAdsLeadPayload['user_column_data'],
  columnId: string
): string | null {
  const field = data.find((f) => f.column_id === columnId);
  return field?.string_value || null;
}

/**
 * Build full name from available fields
 */
function buildFullName(data: GoogleAdsLeadPayload['user_column_data']): string {
  const fullName = getFieldValue(data, COLUMN_IDS.FULL_NAME);
  if (fullName) return fullName;

  const firstName = getFieldValue(data, COLUMN_IDS.FIRST_NAME);
  const lastName = getFieldValue(data, COLUMN_IDS.LAST_NAME);

  if (firstName && lastName) return `${firstName} ${lastName}`;
  if (firstName) return firstName;
  if (lastName) return lastName;

  return 'Unknown Lead';
}

/**
 * Send SMS notification for new lead
 */
async function sendLeadAlert(
  name: string,
  phone: string,
  campaignId: number,
  isTest: boolean
): Promise<void> {
  const env = getEnv();

  const testPrefix = isTest ? '[TEST] ' : '';
  const message = `${testPrefix}🔥 New Google Ads Lead
${name}
${phone}
Campaign: ${campaignId}`;

  try {
    await sendMessage(
      env.quo.phoneNumber,
      env.notifications.alertPhoneNumber,
      message
    );
    log.info('Sent lead alert SMS', { name, phone });
  } catch (error) {
    // Don't fail the webhook if SMS fails
    log.error('Failed to send lead alert SMS', error as Error, { name, phone });
  }
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
  const payload = req.body as GoogleAdsLeadPayload;

  // Basic validation
  if (!payload?.lead_id || !payload?.user_column_data) {
    log.warn('Invalid payload', { hasBody: !!req.body });
    res.status(400).json({ error: 'Invalid payload' });
    return;
  }

  log.info('Received Google Ads lead', {
    leadId: payload.lead_id,
    formId: payload.form_id,
    campaignId: payload.campaign_id,
    isTest: payload.is_test,
  });

  // ============================================
  // VERIFY GOOGLE KEY
  // ============================================
  if (env.googleAds.webhookKey && payload.google_key !== env.googleAds.webhookKey) {
    log.warn('Invalid google_key', { leadId: payload.lead_id });
    res.status(401).json({ error: 'Invalid google_key' });
    return;
  }

  try {
    // ============================================
    // DEDUPLICATION (skip for test leads - Google reuses test lead_ids)
    // ============================================
    if (!payload.is_test) {
      const isNew = await markEventProcessed('google-ads', payload.lead_id);
      if (!isNew) {
        log.info('Duplicate lead ignored', { leadId: payload.lead_id });
        res.status(200).json({ status: 'ignored', reason: 'duplicate' });
        return;
      }
    }

    // ============================================
    // EXTRACT LEAD DATA
    // ============================================
    const name = buildFullName(payload.user_column_data);
    const rawPhone = getFieldValue(payload.user_column_data, COLUMN_IDS.PHONE_NUMBER);
    const email = getFieldValue(payload.user_column_data, COLUMN_IDS.EMAIL);
    const city = getFieldValue(payload.user_column_data, COLUMN_IDS.CITY);

    if (!rawPhone) {
      log.warn('Lead has no phone number', { leadId: payload.lead_id });
      res.status(200).json({ status: 'skipped', reason: 'no_phone' });
      return;
    }

    // Normalize phone (Google usually sends E.164, but let's be safe)
    const e164Phone = normalizePhone(rawPhone);
    if (!e164Phone) {
      log.warn('Invalid phone number', { leadId: payload.lead_id, rawPhone });
      res.status(200).json({ status: 'skipped', reason: 'invalid_phone' });
      return;
    }

    log.info('Extracted lead data', { name, phone: e164Phone, email, city });

    // ============================================
    // FIND OR CREATE PIPEDRIVE PERSON
    // ============================================
    let pipedrivePersonId: number;
    let isNewPerson = false;

    const existingPerson = await searchPersonByPhone(e164Phone);

    if (existingPerson) {
      pipedrivePersonId = existingPerson.id;
      log.info('Found existing Pipedrive person', { personId: pipedrivePersonId });

      // Update if the existing person is an "Unknown Lead"
      if (existingPerson.name.startsWith('Unknown Lead')) {
        await updatePerson(pipedrivePersonId, { name });
        log.info('Updated Unknown Lead with real name', { personId: pipedrivePersonId, name });
      }
    } else {
      // Create new person with lead source note
      const leadNote = `📍 Google Ads Lead
Campaign ID: ${payload.campaign_id}
Form ID: ${payload.form_id}
${payload.gcl_id ? `Click ID: ${payload.gcl_id}` : ''}
${city ? `City: ${city}` : ''}
Submitted: ${payload.lead_submit_time || new Date().toISOString()}`;

      const newPerson = await createPerson(name, e164Phone, {
        email: email || undefined,
        note: leadNote,
      });

      pipedrivePersonId = newPerson.id;
      isNewPerson = true;

      // Store phone mapping for future lookups
      await storePhoneMapping(e164Phone, String(pipedrivePersonId));

      log.info('Created new Pipedrive person', { personId: pipedrivePersonId, name });
    }

    // ============================================
    // CREATE PIPEDRIVE TASK
    // ============================================
    const taskNote = `Lead Source: Google Ads
Campaign ID: ${payload.campaign_id}
${email ? `Email: ${email}` : ''}
${city ? `City: ${city}` : ''}`;

    await createTask(
      pipedrivePersonId,
      `🔥 Google Ads Lead - Call ${name}`,
      taskNote
    );

    log.info('Created follow-up task', { personId: pipedrivePersonId });

    // ============================================
    // SEND SMS ALERT
    // ============================================
    await sendLeadAlert(name, e164Phone, payload.campaign_id, payload.is_test || false);

    // ============================================
    // SUCCESS RESPONSE
    // ============================================
    res.status(200).json({
      status: 'processed',
      pipedrivePersonId,
      isNewPerson,
      leadId: payload.lead_id,
    });

  } catch (error) {
    log.error('Webhook processing failed', error as Error, { leadId: payload.lead_id });

    // Return 200 to acknowledge receipt (prevent infinite retries)
    res.status(200).json({
      status: 'error',
      message: 'Processing failed, logged for investigation',
    });
  }
}
