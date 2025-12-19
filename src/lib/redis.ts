/**
 * Redis client for webhook deduplication and ID mapping
 * Uses Upstash Redis REST API for serverless compatibility
 */

import { Redis } from '@upstash/redis';
import { getEnv } from './env.js';
import { logger } from './logger.js';

let redisClient: Redis | null = null;

/**
 * Get the Redis client instance (lazy initialization)
 */
export function getRedis(): Redis {
  if (!redisClient) {
    const env = getEnv();
    redisClient = new Redis({
      url: env.redis.url,
      token: env.redis.token,
    });
  }
  return redisClient;
}

// Key prefixes for organization
const KEYS = {
  /** Webhook deduplication - expires after 24h */
  dedupe: (source: string, eventId: string) => `dedupe:${source}:${eventId}`,
  /** Pipedrive ID -> Quo ID mapping */
  mapPipedriveToQuo: (pipedriveId: string) => `map:pd-to-quo:${pipedriveId}`,
  /** Quo ID -> Pipedrive ID mapping */
  mapQuoToPipedrive: (quoId: string) => `map:quo-to-pd:${quoId}`,
  /** Phone -> Pipedrive ID mapping (for quick lookups) */
  phoneToPipedrive: (e164Phone: string) => `phone:pd:${e164Phone}`,
  /** Track Pipedrive contacts we created (for loop prevention) */
  middlewareCreated: (pipedriveId: string) => `created-by-us:pd:${pipedriveId}`,
} as const;

// TTLs in seconds
const TTL = {
  dedupe: 86400, // 24 hours
  mapping: 604800, // 7 days
  loopPrevention: 60, // 1 minute - just long enough to catch the webhook
} as const;

/**
 * Check if a webhook event has already been processed
 * @returns true if this is a new event, false if already processed
 */
export async function markEventProcessed(
  source: 'pipedrive' | 'quo',
  eventId: string
): Promise<boolean> {
  const redis = getRedis();
  const key = KEYS.dedupe(source, eventId);

  // SET with NX (only if not exists) and EX (expiry)
  const result = await redis.set(key, 'processed', { nx: true, ex: TTL.dedupe });

  const isNew = result === 'OK';

  logger.debug('Dedupe check', {
    source,
    eventId,
    isNew,
  });

  return isNew;
}

/**
 * Check if event was already processed (without marking it)
 */
export async function wasEventProcessed(
  source: 'pipedrive' | 'quo',
  eventId: string
): Promise<boolean> {
  const redis = getRedis();
  const key = KEYS.dedupe(source, eventId);
  const exists = await redis.exists(key);
  return exists === 1;
}

/**
 * Store a Pipedrive <-> Quo ID mapping
 */
export async function storeIdMapping(
  pipedriveId: string,
  quoId: string
): Promise<void> {
  const redis = getRedis();

  // Store bidirectional mapping
  await Promise.all([
    redis.set(KEYS.mapPipedriveToQuo(pipedriveId), quoId, { ex: TTL.mapping }),
    redis.set(KEYS.mapQuoToPipedrive(quoId), pipedriveId, { ex: TTL.mapping }),
  ]);

  logger.debug('Stored ID mapping', { pipedriveId, quoId });
}

/**
 * Get Quo contact ID from Pipedrive person ID
 */
export async function getQuoIdFromPipedrive(pipedriveId: string): Promise<string | null> {
  const redis = getRedis();
  return redis.get(KEYS.mapPipedriveToQuo(pipedriveId));
}

/**
 * Get Pipedrive person ID from Quo contact ID
 */
export async function getPipedriveIdFromQuo(quoId: string): Promise<string | null> {
  const redis = getRedis();
  return redis.get(KEYS.mapQuoToPipedrive(quoId));
}

/**
 * Store phone -> Pipedrive ID mapping for quick lookups
 */
export async function storePhoneMapping(
  e164Phone: string,
  pipedriveId: string
): Promise<void> {
  const redis = getRedis();
  await redis.set(KEYS.phoneToPipedrive(e164Phone), pipedriveId, { ex: TTL.mapping });
}

/**
 * Get Pipedrive ID from phone number
 */
export async function getPipedriveIdFromPhone(e164Phone: string): Promise<string | null> {
  const redis = getRedis();
  return redis.get(KEYS.phoneToPipedrive(e164Phone));
}

/**
 * Clear a dedupe key (useful if we need to reprocess)
 */
export async function clearDedupeKey(
  source: 'pipedrive' | 'quo',
  eventId: string
): Promise<void> {
  const redis = getRedis();
  await redis.del(KEYS.dedupe(source, eventId));
}

/**
 * Mark that our middleware created this Pipedrive contact
 * Used for loop prevention - expires after 60 seconds
 */
export async function markCreatedByMiddleware(pipedriveId: string): Promise<void> {
  const redis = getRedis();
  await redis.set(KEYS.middlewareCreated(pipedriveId), '1', { ex: TTL.loopPrevention });
  logger.debug('Marked Pipedrive contact as created by middleware', { pipedriveId });
}

/**
 * Check if our middleware recently created this Pipedrive contact
 * Used to prevent sync loops when Quo webhook creates a Pipedrive contact
 */
export async function wasCreatedByMiddleware(pipedriveId: string): Promise<boolean> {
  const redis = getRedis();
  const exists = await redis.exists(KEYS.middlewareCreated(pipedriveId));
  return exists === 1;
}
