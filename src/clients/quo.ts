/**
 * Quo (OpenPhone) API client
 * Handles contact management and message sending
 *
 * API Docs: https://www.openphone.com/docs/api
 */

import { getEnv } from '../lib/env.js';
import { logger } from '../lib/logger.js';

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
