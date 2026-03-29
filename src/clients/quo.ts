/**
 * Quo (OpenPhone) API client
 * Handles contact management and message sending
 *
 * API Docs: https://www.openphone.com/docs/api
 */

import { getEnv } from '@/lib/env';
import { logger } from '@/lib/logger';

const log = logger.child({ client: 'quo' });

const QUO_API_BASE = 'https://api.openphone.com/v1';

interface QuoContact {
  id: string;
  defaultFields: {
    firstName: string | null;
    lastName: string | null;
    company: string | null;
    emails: Array<{ value: string; name?: string; id?: string }>;
    phoneNumbers: Array<{ value: string; name?: string; id?: string }>;
    role: string | null;
  };
  createdAt: string;
  updatedAt: string;
}

interface QuoCustomFieldValue {
  key: string;
  value: string | number | boolean | string[] | null;
}

interface QuoCustomFieldDefinition {
  name: string;
  key: string;
  type: 'address' | 'boolean' | 'date' | 'multi-select' | 'number' | 'string' | 'url';
}

interface QuoContactCreate {
  defaultFields: {
    firstName?: string;
    lastName?: string;
    company?: string;
    role?: string; // Job title in Pipedrive
    emails?: Array<{ value: string; name: string }>;
    phoneNumbers: Array<{ value: string; name: string }>;
  };
  customFields?: QuoCustomFieldValue[];
}

interface QuoPhoneNumber {
  id: string;
  number: string;
  formattedNumber: string;
  name: string;
  users: Array<{ email: string; name: string; role: string }>;
  createdAt: string;
  updatedAt: string;
}

interface QuoMessage {
  id: string;
  to: string[];
  from: string;
  text: string;
  phoneNumberId: string;
  direction: 'incoming' | 'outgoing';
  status: 'queued' | 'sent' | 'delivered' | 'undelivered';
  createdAt: string;
  updatedAt: string;
}

// Cache for phone number ID lookup
let cachedPhoneNumberId: string | null = null;

/**
 * Make an authenticated request to Quo/OpenPhone API
 */
async function quoRequest<T>(
  endpoint: string,
  options: RequestInit = {}
): Promise<T> {
  const env = getEnv();
  const url = `${QUO_API_BASE}${endpoint}`;

  const response = await fetch(url, {
    ...options,
    headers: {
      'Authorization': env.quo.apiKey,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  if (!response.ok) {
    const error = await response.text();
    log.error('Quo API error', new Error(error), {
      endpoint,
      status: response.status,
    });
    throw new Error(`Quo API error: ${response.status} - ${error}`);
  }

  // Some endpoints return 204 No Content
  if (response.status === 204) {
    return {} as T;
  }

  const data = await response.json();
  return data as T;
}

/**
 * Search for a contact by phone number
 * @param phone - E.164 formatted phone number
 */
export async function searchContactByPhone(phone: string): Promise<QuoContact | null> {
  try {
    // OpenPhone requires client-side filtering and paginates at max 50
    let pageToken: string | undefined;

    do {
      const params = new URLSearchParams({ maxResults: '50' });
      if (pageToken) params.set('pageToken', pageToken);

      let result: { data: QuoContact[]; nextPageToken?: string };
      try {
        result = await quoRequest<{ data: QuoContact[]; nextPageToken?: string }>(
          `/contacts?${params.toString()}`
        );
      } catch (pageError) {
        // OpenPhone can 500 on pages with corrupt contact data — skip and continue
        log.warn('Contacts page failed, skipping', { pageToken, error: (pageError as Error).message });
        break;
      }

      const match = result.data?.find((contact) => {
        const phones = contact.defaultFields?.phoneNumbers || [];
        return phones.some((p) => p.value === phone);
      });

      if (match) {
        log.debug('Found contact by phone', { phone, contactId: match.id });
        return match;
      }

      pageToken = result.nextPageToken;
    } while (pageToken);

    log.debug('No contact found for phone', { phone });
    return null;
  } catch (error) {
    log.error('Search contact failed', error as Error, { phone });
    throw error;
  }
}

/**
 * Get a contact by ID
 */
export async function getContact(id: string): Promise<QuoContact | null> {
  try {
    const result = await quoRequest<{ data: QuoContact }>(`/contacts/${id}`);
    return result.data;
  } catch (error) {
    log.error('Get contact failed', error as Error, { contactId: id });
    return null;
  }
}

/**
 * Create a new contact in Quo
 * Note: This creates an "Integration Contact" which is separate from "Native Contacts"
 */
export async function createContact(contact: QuoContactCreate): Promise<QuoContact> {
  log.info('Creating contact', {
    firstName: contact.defaultFields.firstName,
    lastName: contact.defaultFields.lastName,
    phone: contact.defaultFields.phoneNumbers[0]?.value,
  });

  const result = await quoRequest<{ data: QuoContact }>('/contacts', {
    method: 'POST',
    body: JSON.stringify(contact),
  });

  log.info('Created contact', { contactId: result.data.id });
  return result.data;
}

/**
 * Update an existing contact
 *
 * IMPORTANT: The Quo/OpenPhone PATCH API replaces the entire contact state,
 * not just the fields you send. We must read-merge-write to avoid data loss.
 */
export async function updateContact(
  id: string,
  updates: { defaultFields?: Partial<QuoContactCreate['defaultFields']>; customFields?: QuoCustomFieldValue[] }
): Promise<QuoContact> {
  log.info('Updating contact', { contactId: id });

  // Read current state to merge (API replaces, doesn't merge)
  // Native contacts (created in OpenPhone UI) may not be fetchable via API
  const current = await getContact(id);

  let body: Record<string, unknown>;

  if (current) {
    // Merge defaultFields: keep existing values, overlay updates
    const currentDefaults = current.defaultFields || {};
    const mergedDefaults: Record<string, unknown> = {
      firstName: currentDefaults.firstName,
      lastName: currentDefaults.lastName,
      company: currentDefaults.company,
      role: currentDefaults.role,
      phoneNumbers: currentDefaults.phoneNumbers || [],
      emails: currentDefaults.emails || [],
    };

    if (updates.defaultFields) {
      for (const [key, value] of Object.entries(updates.defaultFields)) {
        if (value !== undefined) {
          mergedDefaults[key] = value;
        }
      }
    }

    // Merge customFields: overlay by key, keep existing fields not in updates
    const existingCustom = (current as unknown as { customFields?: QuoCustomFieldValue[] }).customFields || [];
    const mergedCustom = [...existingCustom];
    if (updates.customFields) {
      for (const update of updates.customFields) {
        const idx = mergedCustom.findIndex(f => f.key === update.key);
        if (idx >= 0) {
          mergedCustom[idx] = update;
        } else {
          mergedCustom.push(update);
        }
      }
    }

    body = { defaultFields: mergedDefaults };
    if (mergedCustom.length > 0) {
      body.customFields = mergedCustom;
    }
  } else {
    // Can't read current state (native contact) — send updates as-is
    log.warn('Cannot read contact for merge, sending partial update', { contactId: id });
    body = {};
    if (updates.defaultFields) body.defaultFields = updates.defaultFields;
    if (updates.customFields) body.customFields = updates.customFields;
  }

  const result = await quoRequest<{ data: QuoContact }>(`/contacts/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });

  log.info('Updated contact', { contactId: result.data.id });
  return result.data;
}

/**
 * Delete a contact
 */
export async function deleteContact(id: string): Promise<void> {
  log.info('Deleting contact', { contactId: id });
  await quoRequest(`/contacts/${id}`, { method: 'DELETE' });
  log.info('Deleted contact', { contactId: id });
}

// Cache for custom field definitions
let cachedCustomFields: QuoCustomFieldDefinition[] | null = null;

/**
 * Get all custom field definitions from Quo
 * Results are cached after first call
 */
export async function getCustomFields(): Promise<QuoCustomFieldDefinition[]> {
  if (cachedCustomFields) {
    return cachedCustomFields;
  }

  const result = await quoRequest<{ data: QuoCustomFieldDefinition[] }>('/contact-custom-fields');
  cachedCustomFields = result.data || [];
  log.debug('Fetched custom field definitions', { count: cachedCustomFields.length });
  return cachedCustomFields;
}

/**
 * Look up a custom field key by name (case-insensitive)
 */
export async function getCustomFieldKey(fieldName: string): Promise<string | null> {
  const fields = await getCustomFields();
  const match = fields.find(f => f.name.toLowerCase() === fieldName.toLowerCase());
  return match?.key || null;
}

/**
 * Parse a full name into first/last name components
 * Simple heuristic: first word is firstName, rest is lastName
 */
export function parseFullName(fullName: string): { firstName: string; lastName: string | null } {
  const parts = fullName.trim().split(/\s+/);

  if (parts.length === 0) {
    return { firstName: 'Unknown', lastName: null };
  }

  if (parts.length === 1) {
    return { firstName: parts[0], lastName: null };
  }

  return {
    firstName: parts[0],
    lastName: parts.slice(1).join(' '),
  };
}

/**
 * Get full name from Quo contact
 */
export function getFullName(contact: QuoContact): string {
  const fields = contact.defaultFields;
  const parts = [fields?.firstName, fields?.lastName].filter(Boolean);
  return parts.length > 0 ? parts.join(' ') : 'Unknown';
}

/**
 * Get primary phone from contact
 */
export function getPrimaryPhone(contact: QuoContact): string | null {
  return contact.defaultFields?.phoneNumbers?.[0]?.value || null;
}

/**
 * Send an SMS message via Quo/OpenPhone
 * @param from - Your Quo phone number (E.164 format)
 * @param to - Recipient phone number (E.164 format)
 * @param text - Message content
 */
export async function sendMessage(
  from: string,
  to: string,
  text: string
): Promise<{ id: string }> {
  log.info('Sending SMS', { from, to, textLength: text.length });

  const result = await quoRequest<{ data: { id: string } }>('/messages', {
    method: 'POST',
    body: JSON.stringify({
      from,
      to: [to],
      content: text,
    }),
  });

  log.info('Sent SMS', { messageId: result.data.id });
  return result.data;
}

/**
 * Get the phone number ID for our Quo phone number
 * Required for the messages API to check conversation history
 * Result is cached after first call
 */
export async function getPhoneNumberId(): Promise<string> {
  if (cachedPhoneNumberId) {
    return cachedPhoneNumberId;
  }

  const env = getEnv();
  const ourNumber = env.quo.phoneNumber;

  log.debug('Looking up phone number ID', { phoneNumber: ourNumber });

  const result = await quoRequest<{ data: QuoPhoneNumber[] }>('/phone-numbers');

  const match = result.data?.find((pn) => pn.number === ourNumber);

  if (!match) {
    throw new Error(`Could not find phone number ID for ${ourNumber}`);
  }

  cachedPhoneNumberId = match.id;
  log.debug('Found phone number ID', { phoneNumber: ourNumber, phoneNumberId: match.id });

  return match.id;
}

/**
 * Check if we have any existing conversation history with a phone number
 * Used for deduplication - to avoid re-contacting people we've already messaged
 * @param phone - E.164 formatted phone number to check
 * @returns true if any messages exist (inbound or outbound), false otherwise
 */
export async function hasExistingConversation(phone: string): Promise<boolean> {
  try {
    const phoneNumberId = await getPhoneNumberId();

    // Check for any messages with this participant
    // maxResults=1 is enough - we just need to know if ANY exist
    const params = new URLSearchParams({
      phoneNumberId,
      'participants[]': phone,
      maxResults: '1',
    });

    const result = await quoRequest<{ data: QuoMessage[]; totalItems?: number }>(
      `/messages?${params.toString()}`
    );

    const hasMessages = (result.totalItems ?? 0) > 0 || (result.data?.length ?? 0) > 0;

    log.debug('Checked conversation history', {
      phone,
      hasExistingConversation: hasMessages,
      totalItems: result.totalItems,
    });

    return hasMessages;
  } catch (error) {
    log.error('Failed to check conversation history', error as Error, { phone });
    // On error, assume no existing conversation to avoid blocking the campaign
    // But log it for investigation
    return false;
  }
}
