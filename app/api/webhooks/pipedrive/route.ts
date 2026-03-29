/**
 * Pipedrive Webhook Handler (App Router)
 *
 * Triggers: person.added, person.updated
 * Actions:
 *   1. Sync contact to Quo (OpenPhone)
 *   2. Sync contact to QuickBooks Online
 */

import { NextResponse } from 'next/server'
import { logger } from '@/lib/logger'
import { normalizePhone } from '@/lib/phone'
import { markEventProcessed, storeIdMapping, getQuoIdFromPipedrive, storePhoneMapping, getQbCustomerIdFromPipedrive, storePipedriveToQbMapping, storeQbToPipedriveMapping, trackWebhookProcessed, logHealthError } from '@/lib/redis'
import { searchContactByPhone, createContact, updateContact, parseFullName } from '@/clients/quo'
import { getOrganization, getPerson, getPersonCustomField, setPersonCustomField, PIPEDRIVE_CROSS_SYSTEM_FIELDS } from '@/clients/pipedrive'
import { isQuickBooksConnected, searchCustomerByEmail, searchCustomerByName, createCustomer, getCustomer, updateCustomer } from '@/clients/quickbooks'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const log = logger.child({ handler: 'pipedrive-webhook' })

// Pipedrive custom field keys
const PIPEDRIVE_FIELDS = {
  JOB_TITLE: '6483bb4aaf895975a61ec08210d17978769a8e85',
} as const

// Quo custom field keys (from GET /contact-custom-fields)
const QUO_CUSTOM_FIELDS = {
  ADDRESS: '1725478449101',
  QUICKBOOKS: '69c6ac9e7d6fcf298f2a1cbc',
} as const

// Pipedrive webhook payload structure
interface PipedriveWebhookPayload {
  meta: {
    action: 'added' | 'updated' | 'deleted'
    change_source: string
    company_id: number
    host: string
    id: number // Event ID - use for deduplication
    object: string
    timestamp: number
    user_id: number // Who made the change - critical for loop prevention
    webhook_id: string
    [key: string]: unknown
  }
  data: {
    id: number
    name: string
    first_name: string
    last_name: string
    phones: Array<{ value: string; primary: boolean; label: string }>
    emails: Array<{ value: string; primary: boolean; label: string }>
    org_id: number | null
    org_name: string | null // Organization name (if linked)
    owner_id: number
    // Custom fields accessed by their hash keys
    [key: string]: unknown
  } | null
  previous: {
    [key: string]: unknown
  } | null
}

/**
 * Extract primary phone from Pipedrive person data
 */
function extractPrimaryPhone(phones: Array<{ value: string; primary: boolean; label: string }> | undefined): string | null {
  if (!phones || phones.length === 0) return null
  const primary = phones.find((p) => p.primary)
  return primary?.value || phones[0]?.value || null
}

/**
 * Main webhook handler
 */
export async function POST(request: Request) {
  let payload: PipedriveWebhookPayload
  try {
    payload = await request.json()
  } catch {
    log.warn('Invalid JSON payload')
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  // Basic validation
  if (!payload?.meta || !payload.data) {
    log.warn('Invalid payload received', {
      hasBody: !!payload,
      keys: Object.keys(payload || {}),
      metaKeys: payload?.meta ? Object.keys(payload.meta) : 'no meta',
      dataKeys: payload?.data ? Object.keys(payload.data) : 'no data'
    })
    return NextResponse.json({ error: 'Invalid payload' }, { status: 400 })
  }

  const { meta, data } = payload
  const eventId = `${meta.webhook_id}-${meta.id}-${meta.timestamp}`

  log.info('Received Pipedrive webhook', {
    eventId,
    action: meta.action,
    personId: data.id,
    userId: meta.user_id,
  })

  try {
    // ============================================
    // DEDUPLICATION
    // ============================================
    // Note: No loop prevention needed here. Both webhooks search before creating,
    // so duplicates are naturally prevented. Quo API doesn't fire webhooks for
    // API-created contacts anyway.
    const dedupStart = Date.now()
    const isNew = await markEventProcessed('pipedrive', eventId)
    if (!isNew) {
      log.info('Duplicate event ignored', { eventId })
      return NextResponse.json({ status: 'ignored', reason: 'duplicate' })
    }
    log.info('Phase: dedup', { elapsed: Date.now() - dedupStart })

    // ============================================
    // EXTRACT & VALIDATE PHONE
    // ============================================
    const rawPhone = extractPrimaryPhone(data.phones)
    if (!rawPhone) {
      log.info('No phone number on person, skipping', { personId: data.id })
      return NextResponse.json({ status: 'skipped', reason: 'no_phone' })
    }

    const e164Phone = normalizePhone(rawPhone)
    if (!e164Phone) {
      log.warn('Invalid phone number, skipping', { personId: data.id, rawPhone })
      return NextResponse.json({ status: 'skipped', reason: 'invalid_phone' })
    }

    const startTime = Date.now()

    // Store phone -> Pipedrive mapping for quick lookups later
    await storePhoneMapping(e164Phone, String(data.id))

    // ============================================
    // SHARED DATA FETCH
    // ============================================
    const personName = data.name || 'Unknown'
    const { firstName, lastName } = parseFullName(personName)

    // Get company name - either from webhook payload or fetch from API
    let company: string | undefined = data.org_name || undefined
    if (!company && data.org_id) {
      const org = await getOrganization(data.org_id)
      company = org?.name || undefined
    }

    // Fetch full person data once (used by both Quo sync for job title and QB sync for address)
    let jobTitle: string | undefined = (data[PIPEDRIVE_FIELDS.JOB_TITLE] as string) || undefined
    const fullPerson = (!jobTitle || data.org_id)
      ? await getPerson(data.id) as Record<string, unknown> | null
      : null
    if (!jobTitle && fullPerson) {
      jobTitle = (fullPerson[PIPEDRIVE_FIELDS.JOB_TITLE] as string) || undefined
    }

    // Extract email (shared by Quo and QB sync)
    const emails = data.emails as Array<{ value: string; primary: boolean; label: string }> | undefined
    const primaryEmail = emails?.find(e => e.primary)?.value || emails?.[0]?.value

    // Extract address from Pipedrive custom field (shared by Quo and QB sync)
    const addressField = '5fc7cf5d8c890fe2f7062aaabe1e9b416c851511'
    const streetNumber = fullPerson?.[`${addressField}_street_number`] as string | undefined
    const route = fullPerson?.[`${addressField}_route`] as string | undefined
    const locality = fullPerson?.[`${addressField}_locality`] as string | undefined
    const state = fullPerson?.[`${addressField}_admin_area_level_1`] as string | undefined
    const postalCode = fullPerson?.[`${addressField}_postal_code`] as string | undefined
    const addressLine1 = streetNumber && route ? `${streetNumber} ${route}` : (fullPerson?.[addressField] as string | undefined)
    const formattedAddress = addressLine1
      ? [addressLine1, locality, state, postalCode].filter(Boolean).join(', ')
      : undefined

    log.info('Phase: data-fetch', { elapsed: Date.now() - startTime })

    // ============================================
    // PARALLEL SYNC: QUO + QUICKBOOKS
    // ============================================
    const syncToQuo = async (): Promise<string | null> => {
      // Check Redis cache first, then fall back to Pipedrive custom field
      let quoContactId = await getQuoIdFromPipedrive(String(data.id))
      if (!quoContactId) {
        quoContactId = await getPersonCustomField(data.id, PIPEDRIVE_CROSS_SYSTEM_FIELDS.QUO_CONTACT_ID)
        if (quoContactId) {
          // Re-populate Redis cache
          await storeIdMapping(String(data.id), quoContactId)
          log.debug('Restored Quo mapping from Pipedrive field', { pipedriveId: data.id, quoId: quoContactId })
        }
      }

      if (quoContactId) {
        // Update existing contact
        log.info('Updating existing Quo contact', { pipedriveId: data.id, quoId: quoContactId })

        await updateContact(quoContactId, {
          defaultFields: {
            firstName,
            lastName: lastName || undefined,
            company,
            role: jobTitle,
            phoneNumbers: [{ value: e164Phone, name: 'mobile' }],
            emails: primaryEmail ? [{ value: primaryEmail, name: 'email' }] : undefined,
          },
        })
      } else {
        // Check if contact exists in Quo by phone
        const existingContact = await searchContactByPhone(e164Phone)

        if (existingContact) {
          // Link existing contact
          quoContactId = existingContact.id
          await storeIdMapping(String(data.id), quoContactId)
          await setPersonCustomField(data.id, PIPEDRIVE_CROSS_SYSTEM_FIELDS.QUO_CONTACT_ID, quoContactId)

          // Update with latest info
          await updateContact(quoContactId, {
            defaultFields: {
              firstName,
              lastName: lastName || undefined,
              company,
              role: jobTitle,
              emails: primaryEmail ? [{ value: primaryEmail, name: 'email' }] : undefined,
            },
          })

          log.info('Linked existing Quo contact', { pipedriveId: data.id, quoId: quoContactId })
        } else {
          // Create new contact in Quo
          const newContact = await createContact({
            defaultFields: {
              firstName,
              lastName: lastName || undefined,
              company,
              role: jobTitle,
              phoneNumbers: [{ value: e164Phone, name: 'mobile' }],
              emails: primaryEmail ? [{ value: primaryEmail, name: 'email' }] : undefined,
            },
          })

          quoContactId = newContact.id
          await storeIdMapping(String(data.id), quoContactId)
          await setPersonCustomField(data.id, PIPEDRIVE_CROSS_SYSTEM_FIELDS.QUO_CONTACT_ID, quoContactId)

          log.info('Created new Quo contact', { pipedriveId: data.id, quoId: quoContactId })
        }
      }

      return quoContactId
    }

    const syncToQuickBooks = async (): Promise<string | null> => {
      const qbConnected = await isQuickBooksConnected()
      if (!qbConnected) {
        log.debug('QuickBooks not connected, skipping sync')
        return null
      }

      // Check Redis cache first, then fall back to Pipedrive custom field
      let qbCustomerId: string | null = await getQbCustomerIdFromPipedrive(String(data.id))
      if (!qbCustomerId) {
        qbCustomerId = await getPersonCustomField(data.id, PIPEDRIVE_CROSS_SYSTEM_FIELDS.QB_CUSTOMER_ID)
        if (qbCustomerId) {
          await storePipedriveToQbMapping(String(data.id), qbCustomerId)
          await storeQbToPipedriveMapping(qbCustomerId, String(data.id))
          log.debug('Restored QB mapping from Pipedrive field', { pipedriveId: data.id, qbId: qbCustomerId })
        }
      }

      if (qbCustomerId) {
        // Update existing QuickBooks customer
        const existingCustomer = await getCustomer(qbCustomerId)
        if (existingCustomer && existingCustomer.Id) {
          const syncToken = (existingCustomer as unknown as Record<string, unknown>).SyncToken as string

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
          })

          log.info('Updated QuickBooks customer', {
            pipedriveId: data.id,
            qbCustomerId,
          })
        }
      } else {
        // Search by email first (most reliable)
        let existingCustomer = primaryEmail
          ? await searchCustomerByEmail(primaryEmail)
          : null

        // If not found by email, try by display name
        if (!existingCustomer && personName && personName !== 'Unknown') {
          existingCustomer = await searchCustomerByName(personName)
        }

        if (existingCustomer && existingCustomer.Id) {
          // Link existing customer
          qbCustomerId = existingCustomer.Id
          await storePipedriveToQbMapping(String(data.id), qbCustomerId)
          await storeQbToPipedriveMapping(qbCustomerId, String(data.id))
          await setPersonCustomField(data.id, PIPEDRIVE_CROSS_SYSTEM_FIELDS.QB_CUSTOMER_ID, qbCustomerId)
          log.info('Linked existing QuickBooks customer', {
            pipedriveId: data.id,
            qbCustomerId,
          })
        } else {
          // Create new customer in QuickBooks
          const newCustomer = await createCustomer({
            displayName: personName,
            firstName,
            lastName: lastName || undefined,
            companyName: company,
            email: primaryEmail,
            phone: e164Phone,
          })

          qbCustomerId = newCustomer.Id || null
          if (qbCustomerId) {
            await storePipedriveToQbMapping(String(data.id), qbCustomerId)
            await storeQbToPipedriveMapping(qbCustomerId, String(data.id))
            await setPersonCustomField(data.id, PIPEDRIVE_CROSS_SYSTEM_FIELDS.QB_CUSTOMER_ID, qbCustomerId)
          }
          log.info('Created new QuickBooks customer', {
            pipedriveId: data.id,
            qbCustomerId,
          })
        }
      }

      return qbCustomerId
    }

    const [quoResult, qbResult] = await Promise.allSettled([
      syncToQuo(),
      syncToQuickBooks(),
    ])

    const quoContactId = quoResult.status === 'fulfilled' ? quoResult.value : null
    const qbCustomerId = qbResult.status === 'fulfilled' ? qbResult.value : null

    if (quoResult.status === 'rejected') {
      log.error('Quo sync failed', quoResult.reason as Error, { pipedriveId: data.id })
    }
    if (qbResult.status === 'rejected') {
      log.error('QuickBooks sync failed', qbResult.reason as Error, { pipedriveId: data.id })
    }

    log.info('Phase: sync-complete', { elapsed: Date.now() - startTime })

    // ============================================
    // ENRICH QUO CONTACT: QB Link + Address
    // ============================================
    if (quoContactId && (qbCustomerId || formattedAddress)) {
      try {
        const customFields: Array<{ key: string; value: string }> = []

        if (qbCustomerId) {
          customFields.push({
            key: QUO_CUSTOM_FIELDS.QUICKBOOKS,
            value: `https://app.qbo.intuit.com/app/customerdetail?nameId=${qbCustomerId}`,
          })
        }

        if (formattedAddress) {
          customFields.push({
            key: QUO_CUSTOM_FIELDS.ADDRESS,
            value: formattedAddress,
          })
        }

        await updateContact(quoContactId, { customFields })
        log.info('Enriched Quo contact with custom fields', {
          quoId: quoContactId,
          fields: customFields.map(f => f.key),
        })
      } catch (error) {
        // Don't fail the webhook if custom field enrichment fails
        log.error('Quo custom field enrichment failed', error as Error, {
          quoId: quoContactId,
          pipedriveId: data.id,
        })
      }
    }

    // Track successful processing for health dashboard
    await trackWebhookProcessed('pipedrive')

    return NextResponse.json({
      status: 'synced',
      pipedriveId: data.id,
      quoId: quoContactId,
      qbCustomerId,
    })
  } catch (error) {
    log.error('Webhook processing failed', error as Error, { eventId })

    // Log error for health dashboard
    await logHealthError('pipedrive', (error as Error).message, eventId)

    // Return 200 to acknowledge receipt (prevent retries that could cause issues)
    // The error is logged for investigation
    return NextResponse.json({
      status: 'error',
      message: 'Processing failed, logged for investigation',
    })
  }
}
