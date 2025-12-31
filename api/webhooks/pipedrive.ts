/**
 * Pipedrive Webhook Handler
 *
 * Triggers: person.added, person.updated
 * Actions:
 *   1. Sync contact to Quo (OpenPhone)
 *   2. Sync contact to QuickBooks Online
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { logger } from '../../src/lib/logger.js';
import { normalizePhone } from '../../src/lib/phone.js';
import { markEventProcessed, storeIdMapping, getQuoIdFromPipedrive, storePhoneMapping, getQbCustomerIdFromPipedrive, storePipedriveToQbMapping, storeQbToPipedriveMapping, trackWebhookProcessed, logHealthError } from '../../src/lib/redis.js';
import { searchContactByPhone, createContact, updateContact, parseFullName } from '../../src/clients/quo.js';
import { getOrganization, getPerson } from '../../src/clients/pipedrive.js';
import { isQuickBooksConnected, searchCustomerByEmail, searchCustomerByName, createCustomer, getCustomer, updateCustomer } from '../../src/clients/quickbooks.js';

const log = logger.child({ handler: 'pipedrive-webhook' });

// Pipedrive custom field keys
const PIPEDRIVE_FIELDS = {
  JOB_TITLE: '6483bb4aaf895975a61ec08210d17978769a8e85',
} as const;

// Pipedrive webhook payload structure
interface PipedriveWebhookPayload {
  meta: {
    action: 'added' | 'updated' | 'deleted';
    change_source: string;
    company_id: number;
    host: string;
    id: number; // Event ID - use for deduplication
    object: string;
    timestamp: number;
    user_id: number; // Who made the change - critical for loop prevention
    webhook_id: string;
    [key: string]: unknown;
  };
  data: {
    id: number;
    name: string;
    first_name: string;
    last_name: string;
    phones: Array<{ value: string; primary: boolean; label: string }>;
    emails: Array<{ value: string; primary: boolean; label: string }>;
    org_id: number | null;
    org_name: string | null; // Organization name (if linked)
    owner_id: number;
    // Custom fields accessed by their hash keys
    [key: string]: unknown;
  } | null;
  previous: {
    [key: string]: unknown;
  } | null;
}

/**
 * Extract primary phone from Pipedrive person data
 */
function extractPrimaryPhone(phones: Array<{ value: string; primary: boolean; label: string }> | undefined): string | null {
  if (!phones || phones.length === 0) return null;
  const primary = phones.find((p) => p.primary);
  return primary?.value || phones[0]?.value || null;
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

  const payload = req.body as PipedriveWebhookPayload;

  // Basic validation
  if (!payload?.meta || !payload.data) {
    log.warn('Invalid payload received', {
      hasBody: !!req.body,
      keys: Object.keys(payload || {}),
      metaKeys: payload?.meta ? Object.keys(payload.meta) : 'no meta',
      dataKeys: payload?.data ? Object.keys(payload.data) : 'no data'
    });
    res.status(400).json({ error: 'Invalid payload' });
    return;
  }

  const { meta, data } = payload;
  const eventId = `${meta.webhook_id}-${meta.id}-${meta.timestamp}`;

  log.info('Received Pipedrive webhook', {
    eventId,
    action: meta.action,
    personId: data.id,
    userId: meta.user_id,
  });

  try {
    // ============================================
    // DEDUPLICATION
    // ============================================
    // Note: No loop prevention needed here. Both webhooks search before creating,
    // so duplicates are naturally prevented. Quo API doesn't fire webhooks for
    // API-created contacts anyway.
    const isNew = await markEventProcessed('pipedrive', eventId);
    if (!isNew) {
      log.info('Duplicate event ignored', { eventId });
      res.status(200).json({ status: 'ignored', reason: 'duplicate' });
      return;
    }

    // ============================================
    // EXTRACT & VALIDATE PHONE
    // ============================================
    const rawPhone = extractPrimaryPhone(data.phones);
    if (!rawPhone) {
      log.info('No phone number on person, skipping', { personId: data.id });
      res.status(200).json({ status: 'skipped', reason: 'no_phone' });
      return;
    }

    const e164Phone = normalizePhone(rawPhone);
    if (!e164Phone) {
      log.warn('Invalid phone number, skipping', { personId: data.id, rawPhone });
      res.status(200).json({ status: 'skipped', reason: 'invalid_phone' });
      return;
    }

    // Store phone -> Pipedrive mapping for quick lookups later
    await storePhoneMapping(e164Phone, String(data.id));

    // ============================================
    // SYNC TO QUO
    // ============================================
    const personName = data.name || 'Unknown';
    const { firstName, lastName } = parseFullName(personName);

    // Get company name - either from webhook payload or fetch from API
    let company: string | undefined = data.org_name || undefined;
    if (!company && data.org_id) {
      const org = await getOrganization(data.org_id);
      company = org?.name || undefined;
    }

    // Get job title from custom field - webhooks often don't include custom fields,
    // so fetch from API if not present
    let jobTitle: string | undefined = (data[PIPEDRIVE_FIELDS.JOB_TITLE] as string) || undefined;
    if (!jobTitle) {
      const fullPerson = await getPerson(data.id) as Record<string, unknown> | null;
      jobTitle = (fullPerson?.[PIPEDRIVE_FIELDS.JOB_TITLE] as string) || undefined;
    }

    // Check if we already have a mapping
    let quoContactId = await getQuoIdFromPipedrive(String(data.id));

    if (quoContactId) {
      // Update existing contact
      log.info('Updating existing Quo contact', { pipedriveId: data.id, quoId: quoContactId });

      await updateContact(quoContactId, {
        defaultFields: {
          firstName,
          lastName: lastName || undefined,
          company,
          role: jobTitle,
          phoneNumbers: [{ value: e164Phone, name: 'mobile' }],
        },
      });
    } else {
      // Check if contact exists in Quo by phone
      const existingContact = await searchContactByPhone(e164Phone);

      if (existingContact) {
        // Link existing contact
        quoContactId = existingContact.id;
        await storeIdMapping(String(data.id), quoContactId);

        // Update with latest info
        await updateContact(quoContactId, {
          defaultFields: {
            firstName,
            lastName: lastName || undefined,
            company,
            role: jobTitle,
          },
        });

        log.info('Linked existing Quo contact', { pipedriveId: data.id, quoId: quoContactId });
      } else {
        // Create new contact in Quo
        const newContact = await createContact({
          defaultFields: {
            firstName,
            lastName: lastName || undefined,
            company,
            role: jobTitle,
            phoneNumbers: [{ value: e164Phone, name: 'mobile' }],
          },
        });

        quoContactId = newContact.id;
        await storeIdMapping(String(data.id), quoContactId);

        log.info('Created new Quo contact', { pipedriveId: data.id, quoId: quoContactId });
      }
    }

    // ============================================
    // SYNC TO QUICKBOOKS
    // ============================================
    let qbCustomerId: string | null = null;

    // Only sync if QuickBooks is connected
    const qbConnected = await isQuickBooksConnected();
    if (qbConnected) {
      try {
        // Check if we already have a mapping
        qbCustomerId = await getQbCustomerIdFromPipedrive(String(data.id));

        // Get email and address for QuickBooks
        const emails = data.emails as Array<{ value: string; primary: boolean; label: string }> | undefined;
        const primaryEmail = emails?.find(e => e.primary)?.value || emails?.[0]?.value;

        // Get address from Pipedrive custom field (fetch full person data)
        const fullPerson = await getPerson(data.id) as Record<string, unknown> | null;
        const addressField = '5fc7cf5d8c890fe2f7062aaabe1e9b416c851511';
        const streetNumber = fullPerson?.[`${addressField}_street_number`] as string | undefined;
        const route = fullPerson?.[`${addressField}_route`] as string | undefined;
        const locality = fullPerson?.[`${addressField}_locality`] as string | undefined;
        const state = fullPerson?.[`${addressField}_admin_area_level_1`] as string | undefined;
        const postalCode = fullPerson?.[`${addressField}_postal_code`] as string | undefined;
        const addressLine1 = streetNumber && route ? `${streetNumber} ${route}` : (fullPerson?.[addressField] as string | undefined);

        if (qbCustomerId) {
          // Update existing QuickBooks customer
          try {
            const existingCustomer = await getCustomer(qbCustomerId);
            if (existingCustomer && existingCustomer.Id) {
              const syncToken = (existingCustomer as unknown as Record<string, unknown>).SyncToken as string;

              await updateCustomer(qbCustomerId, {
                SyncToken: syncToken,
                DisplayName: personName,
                GivenName: firstName,
                FamilyName: lastName || undefined,
                CompanyName: company,
                PrimaryEmailAddr: primaryEmail ? { Address: primaryEmail } : undefined,
                PrimaryPhone: { FreeFormNumber: e164Phone },
                BillAddr: addressLine1 ? {
                  Line1: addressLine1,
                  City: locality,
                  CountrySubDivisionCode: state,
                  PostalCode: postalCode,
                } : undefined,
              });

              log.info('Updated QuickBooks customer', {
                pipedriveId: data.id,
                qbCustomerId,
              });
            }
          } catch (updateError) {
            log.error('Failed to update QuickBooks customer', updateError as Error, {
              pipedriveId: data.id,
              qbCustomerId,
            });
          }
        } else {
          // Search by email first (most reliable)
          let existingCustomer = primaryEmail
            ? await searchCustomerByEmail(primaryEmail)
            : null;

          // If not found by email, try by display name
          if (!existingCustomer && personName && personName !== 'Unknown') {
            existingCustomer = await searchCustomerByName(personName);
          }

          if (existingCustomer && existingCustomer.Id) {
            // Link existing customer
            qbCustomerId = existingCustomer.Id;
            await storePipedriveToQbMapping(String(data.id), qbCustomerId);
            await storeQbToPipedriveMapping(qbCustomerId, String(data.id));
            log.info('Linked existing QuickBooks customer', {
              pipedriveId: data.id,
              qbCustomerId,
            });
          } else {
            // Create new customer in QuickBooks
            const newCustomer = await createCustomer({
              displayName: personName,
              firstName,
              lastName: lastName || undefined,
              companyName: company,
              email: primaryEmail,
              phone: e164Phone,
            });

            qbCustomerId = newCustomer.Id || null;
            if (qbCustomerId) {
              await storePipedriveToQbMapping(String(data.id), qbCustomerId);
              await storeQbToPipedriveMapping(qbCustomerId, String(data.id));
            }
            log.info('Created new QuickBooks customer', {
              pipedriveId: data.id,
              qbCustomerId,
            });
          }
        }
      } catch (qbError) {
        // Don't fail the webhook if QuickBooks sync fails
        log.error('QuickBooks sync failed', qbError as Error, { pipedriveId: data.id });
      }
    } else {
      log.debug('QuickBooks not connected, skipping sync');
    }

    // Track successful processing for health dashboard
    await trackWebhookProcessed('pipedrive');

    res.status(200).json({
      status: 'synced',
      pipedriveId: data.id,
      quoId: quoContactId,
      qbCustomerId,
    });
  } catch (error) {
    log.error('Webhook processing failed', error as Error, { eventId });

    // Log error for health dashboard
    await logHealthError('pipedrive', (error as Error).message, eventId);

    // Return 200 to acknowledge receipt (prevent retries that could cause issues)
    // The error is logged for investigation
    res.status(200).json({
      status: 'error',
      message: 'Processing failed, logged for investigation',
    });
  }
}
