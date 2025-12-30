/**
 * Pipedrive API client
 * Handles person CRUD and activity logging
 */

import { getEnv } from '../lib/env.js';
import { logger } from '../lib/logger.js';

const log = logger.child({ client: 'pipedrive' });

interface PipedrivePerson {
  id: number;
  name: string;
  phone: Array<{ value: string; primary: boolean }>;
  email: Array<{ value: string; primary: boolean }>;
  org_id?: number;
  owner_id?: {
    id: number;
    name: string;
    email: string;
  };
}

interface PipedriveOrganization {
  id: number;
  name: string;
  address?: string;
}

interface PipedriveActivity {
  id: number;
  type: string;
  subject: string;
  person_id: number;
  done: boolean;
}

interface SearchResult {
  items: Array<{
    item: PipedrivePerson;
  }>;
}

/**
 * Make an authenticated request to Pipedrive API
 */
async function pipedriveRequest<T>(
  endpoint: string,
  options: RequestInit = {}
): Promise<T> {
  const env = getEnv();
  const baseUrl = `https://api.pipedrive.com/v1`;
  const url = new URL(`${baseUrl}${endpoint}`);
  url.searchParams.set('api_token', env.pipedrive.apiKey);

  const response = await fetch(url.toString(), {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  if (!response.ok) {
    const error = await response.text();
    log.error('Pipedrive API error', new Error(error), {
      endpoint,
      status: response.status,
    });
    throw new Error(`Pipedrive API error: ${response.status} - ${error}`);
  }

  const data = await response.json();
  return data.data as T;
}

/**
 * Search for a person by phone number
 * @param phone - E.164 formatted phone number
 */
export async function searchPersonByPhone(phone: string): Promise<PipedrivePerson | null> {
  try {
    const result = await pipedriveRequest<SearchResult>(
      `/persons/search?term=${encodeURIComponent(phone)}&fields=phone`
    );

    if (result?.items?.length > 0) {
      log.debug('Found person by phone', { phone, personId: result.items[0].item.id });
      return result.items[0].item;
    }

    log.debug('No person found for phone', { phone });
    return null;
  } catch (error) {
    log.error('Search person failed', error as Error, { phone });
    throw error;
  }
}

/**
 * Get a person by ID
 */
export async function getPerson(id: number): Promise<PipedrivePerson | null> {
  try {
    return await pipedriveRequest<PipedrivePerson>(`/persons/${id}`);
  } catch (error) {
    log.error('Get person failed', error as Error, { personId: id });
    return null;
  }
}

/**
 * Get an organization by ID
 */
export async function getOrganization(id: number): Promise<PipedriveOrganization | null> {
  try {
    return await pipedriveRequest<PipedriveOrganization>(`/organizations/${id}`);
  } catch (error) {
    log.error('Get organization failed', error as Error, { orgId: id });
    return null;
  }
}

/**
 * Create a new person
 * @param name - Person name
 * @param phone - E.164 formatted phone number
 * @param options - Optional additional fields
 */
export async function createPerson(
  name: string,
  phone: string,
  options?: {
    email?: string;
    note?: string; // For lead source tracking
  }
): Promise<PipedrivePerson> {
  log.info('Creating person', { name, phone });

  const body: Record<string, unknown> = {
    name,
    phone: [{ value: phone, primary: true }],
  };

  if (options?.email) {
    body.email = [{ value: options.email, primary: true }];
  }

  const person = await pipedriveRequest<PipedrivePerson>('/persons', {
    method: 'POST',
    body: JSON.stringify(body),
  });

  // Add note separately if provided (for lead source tracking)
  if (options?.note) {
    await pipedriveRequest('/notes', {
      method: 'POST',
      body: JSON.stringify({
        content: options.note,
        person_id: person.id,
      }),
    });
  }

  log.info('Created person', { personId: person.id, name });
  return person;
}

/**
 * Update a person's details
 */
export async function updatePerson(
  id: number,
  updates: {
    name?: string;
    phone?: string;
    email?: string;
  }
): Promise<PipedrivePerson> {
  log.info('Updating person', { personId: id, updates });

  const body: Record<string, unknown> = {};

  if (updates.name) body.name = updates.name;
  if (updates.phone) body.phone = [{ value: updates.phone, primary: true }];
  if (updates.email) body.email = [{ value: updates.email, primary: true }];

  const person = await pipedriveRequest<PipedrivePerson>(`/persons/${id}`, {
    method: 'PUT',
    body: JSON.stringify(body),
  });

  log.info('Updated person', { personId: person.id });
  return person;
}

/**
 * Log an activity (call or SMS) to a person
 */
export async function logActivity(
  personId: number,
  type: 'call' | 'sms',
  details: {
    subject: string;
    note?: string;
    duration?: number; // For calls, in seconds
  }
): Promise<PipedriveActivity> {
  log.info('Logging activity', { personId, type, subject: details.subject });

  const activity = await pipedriveRequest<PipedriveActivity>('/activities', {
    method: 'POST',
    body: JSON.stringify({
      type,
      subject: details.subject,
      person_id: personId,
      note: details.note,
      duration: details.duration,
      done: true,
    }),
  });

  log.info('Logged activity', { activityId: activity.id, personId });
  return activity;
}

/**
 * Create a task (undone activity) for a person
 * Used for things like "Call this lead back"
 */
export async function createTask(
  personId: number,
  subject: string,
  note?: string
): Promise<PipedriveActivity> {
  log.info('Creating task', { personId, subject });

  const activity = await pipedriveRequest<PipedriveActivity>('/activities', {
    method: 'POST',
    body: JSON.stringify({
      type: 'task',
      subject,
      person_id: personId,
      note,
      done: false, // Task is not yet completed
      due_date: new Date().toISOString().split('T')[0], // Due today
      due_time: new Date().toTimeString().slice(0, 5), // Due now
    }),
  });

  log.info('Created task', { activityId: activity.id, personId });
  return activity;
}

/**
 * Extract primary phone from Pipedrive person
 */
export function getPrimaryPhone(person: PipedrivePerson): string | null {
  const primary = person.phone?.find((p) => p.primary);
  return primary?.value || person.phone?.[0]?.value || null;
}

/**
 * Incrementally update a person - only add new fields, don't overwrite existing
 * Used by AI Listener to add extracted data without overwriting known good data
 */
export async function updatePersonIncremental(
  id: number,
  updates: {
    name?: string;
    phone?: string;
    email?: string;
    address?: string;
    city?: string;
    state?: string;
    zipCode?: string;
  }
): Promise<{ updated: boolean; fields: string[] }> {
  // First get the current person data
  const person = await getPerson(id);
  if (!person) {
    log.warn('Cannot update non-existent person', { personId: id });
    return { updated: false, fields: [] };
  }

  const body: Record<string, unknown> = {};
  const updatedFields: string[] = [];

  // Only update name if current name is "Unknown Lead..." pattern
  if (updates.name && person.name.startsWith('Unknown Lead')) {
    body.name = updates.name;
    updatedFields.push('name');
  }

  // Add phone if person has no phone
  const currentPhone = getPrimaryPhone(person);
  if (updates.phone && !currentPhone) {
    body.phone = [{ value: updates.phone, primary: true }];
    updatedFields.push('phone');
  }

  // Only add email if person has no email
  const currentEmail = getPrimaryEmail(person);
  if (updates.email && !currentEmail) {
    body.email = [{ value: updates.email, primary: true }];
    updatedFields.push('email');
  }

  // Personal address field - custom field with hash key
  // Main field key: 5fc7cf5d8c890fe2f7062aaabe1e9b416c851511
  const ADDR_KEY = '5fc7cf5d8c890fe2f7062aaabe1e9b416c851511';

  if (updates.address || updates.city || updates.state || updates.zipCode) {
    // Set individual subfields for better data structure
    if (updates.address) {
      body[`${ADDR_KEY}_route`] = updates.address;
      updatedFields.push('street');
    }
    if (updates.city) {
      body[`${ADDR_KEY}_locality`] = updates.city;
      updatedFields.push('city');
    }
    if (updates.state) {
      body[`${ADDR_KEY}_admin_area_level_1`] = updates.state;
      updatedFields.push('state');
    }
    if (updates.zipCode) {
      body[`${ADDR_KEY}_postal_code`] = updates.zipCode;
      updatedFields.push('zip');
    }

    // Also build formatted address for the main field
    const addressParts = [
      updates.address,
      updates.city,
      updates.state && updates.zipCode ? `${updates.state} ${updates.zipCode}` : (updates.state || updates.zipCode),
    ].filter(Boolean);

    if (addressParts.length > 0) {
      body[ADDR_KEY] = addressParts.join(', ');
    }
  }

  // Nothing to update
  if (Object.keys(body).length === 0) {
    log.debug('No incremental updates needed', { personId: id });
    return { updated: false, fields: [] };
  }

  log.info('Incremental person update', { personId: id, fields: updatedFields });

  await pipedriveRequest<PipedrivePerson>(`/persons/${id}`, {
    method: 'PUT',
    body: JSON.stringify(body),
  });

  return { updated: true, fields: updatedFields };
}

/**
 * Extract primary email from Pipedrive person
 */
export function getPrimaryEmail(person: PipedrivePerson): string | null {
  const primary = person.email?.find((e) => e.primary);
  return primary?.value || person.email?.[0]?.value || null;
}

// ============================================
// ATTRIBUTION ENGINE FUNCTIONS
// ============================================

// Custom field key for "Referred by" (links to another Person)
const REFERRED_BY_FIELD_KEY = '34e9bd78a631d8950b507a722c4e245a9ef9de11';

interface PipedriveUser {
  id: number;
  name: string;
  email: string;
  active_flag: boolean;
}

/**
 * Get the "Referred by" person ID from a person record
 * Used for chain traversal in attribution
 * @returns The Pipedrive Person ID that referred this person, or null
 */
export async function getPersonReferredBy(personId: number): Promise<number | null> {
  try {
    // Get full person details including custom fields
    const env = getEnv();
    const baseUrl = `https://api.pipedrive.com/v1`;
    const url = new URL(`${baseUrl}/persons/${personId}`);
    url.searchParams.set('api_token', env.pipedrive.apiKey);

    const response = await fetch(url.toString());
    if (!response.ok) {
      log.error('Failed to get person for referred by', new Error(`Status ${response.status}`), { personId });
      return null;
    }

    const data = await response.json();
    const person = data.data;

    if (!person) {
      return null;
    }

    // The "Referred by" field is a people type field - value is the person ID
    const referredById = person[REFERRED_BY_FIELD_KEY];

    if (referredById) {
      log.debug('Found referred by', { personId, referredById });
      return typeof referredById === 'number' ? referredById : parseInt(referredById, 10);
    }

    return null;
  } catch (error) {
    log.error('Get referred by failed', error as Error, { personId });
    return null;
  }
}

/**
 * Get a Pipedrive user (salesperson) by ID
 */
export async function getPipedriveUser(userId: number): Promise<PipedriveUser | null> {
  try {
    return await pipedriveRequest<PipedriveUser>(`/users/${userId}`);
  } catch (error) {
    log.error('Get Pipedrive user failed', error as Error, { userId });
    return null;
  }
}

/**
 * Get the owner (salesperson) of a person
 * @returns The owner's user ID, or null
 */
export async function getPersonOwnerId(personId: number): Promise<number | null> {
  const person = await getPerson(personId);
  if (!person) {
    return null;
  }
  return person.owner_id?.id || null;
}
