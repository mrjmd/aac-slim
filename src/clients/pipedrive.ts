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
  owner_id?: number;
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
 * Extract primary email from Pipedrive person
 */
export function getPrimaryEmail(person: PipedrivePerson): string | null {
  const primary = person.email?.find((e) => e.primary);
  return primary?.value || person.email?.[0]?.value || null;
}
