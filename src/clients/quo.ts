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

interface QuoContactCreate {
  defaultFields: {
    firstName?: string;
    lastName?: string;
    company?: string;
    role?: string; // Job title in Pipedrive
    emails?: Array<{ value: string; name: string }>;
    phoneNumbers: Array<{ value: string; name: string }>;
  };
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
    // OpenPhone returns all contacts, we need to filter client-side
    const result = await quoRequest<{ data: QuoContact[] }>('/contacts');

    // Find contact with matching phone number
    const match = result.data?.find((contact) => {
      const phones = contact.defaultFields?.phoneNumbers || [];
      return phones.some((p) => p.value === phone);
    });

    if (match) {
      log.debug('Found contact by phone', { phone, contactId: match.id });
      return match;
    }

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
 */
export async function updateContact(
  id: string,
  updates: { defaultFields: Partial<QuoContactCreate['defaultFields']> }
): Promise<QuoContact> {
  log.info('Updating contact', { contactId: id, updates });

  const result = await quoRequest<{ data: QuoContact }>(`/contacts/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(updates),
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
