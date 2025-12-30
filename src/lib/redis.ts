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
  /** Pipedrive ID -> QuickBooks Customer ID mapping */
  mapPipedriveToQb: (pipedriveId: string) => `map:pd-to-qb:${pipedriveId}`,
  /** QuickBooks Customer ID -> Pipedrive ID reverse mapping */
  mapQbToPipedrive: (qbCustomerId: string) => `map:qb-to-pd:${qbCustomerId}`,
  /** QuickBooks OAuth tokens */
  qbOAuthTokens: () => 'oauth:quickbooks:tokens',
  /** Attribution result for a specific invoice */
  attribution: (invoiceId: string) => `attribution:${invoiceId}`,
  /** Track which invoices have been processed */
  attributionProcessed: (invoiceId: string) => `attribution:processed:${invoiceId}`,
} as const;

// TTLs in seconds
const TTL = {
  dedupe: 86400, // 24 hours
  mapping: 604800, // 7 days
  loopPrevention: 60, // 1 minute - just long enough to catch the webhook
  attribution: 31536000, // 1 year - keep attribution records long-term
} as const;

/**
 * Check if a webhook event has already been processed
 * @returns true if this is a new event, false if already processed
 */
export async function markEventProcessed(
  source: 'pipedrive' | 'quo' | 'google-ads',
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
  source: 'pipedrive' | 'quo' | 'google-ads',
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
  source: 'pipedrive' | 'quo' | 'google-ads',
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

// ============================================
// QUICKBOOKS INTEGRATION
// ============================================

export interface QBOAuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // Unix timestamp
  refreshTokenExpiresAt: number; // Unix timestamp
}

/**
 * Store QuickBooks OAuth tokens
 * Note: Upstash Redis auto-serializes objects, so we store directly
 */
export async function storeQBTokens(tokens: QBOAuthTokens): Promise<void> {
  const redis = getRedis();
  await redis.set(KEYS.qbOAuthTokens(), tokens);
  logger.debug('Stored QuickBooks OAuth tokens');
}

/**
 * Get QuickBooks OAuth tokens
 * Note: Upstash Redis auto-deserializes, so we get the object directly
 */
export async function getQBTokens(): Promise<QBOAuthTokens | null> {
  const redis = getRedis();
  const data = await redis.get<QBOAuthTokens>(KEYS.qbOAuthTokens());
  return data || null;
}

/**
 * Store Pipedrive -> QuickBooks Customer ID mapping
 */
export async function storePipedriveToQbMapping(
  pipedriveId: string,
  qbCustomerId: string
): Promise<void> {
  const redis = getRedis();
  await redis.set(KEYS.mapPipedriveToQb(pipedriveId), qbCustomerId, { ex: TTL.mapping });
  logger.debug('Stored Pipedrive->QB mapping', { pipedriveId, qbCustomerId });
}

/**
 * Get QuickBooks Customer ID from Pipedrive Person ID
 */
export async function getQbCustomerIdFromPipedrive(pipedriveId: string): Promise<string | null> {
  const redis = getRedis();
  return redis.get(KEYS.mapPipedriveToQb(pipedriveId));
}

/**
 * Store QuickBooks Customer ID -> Pipedrive Person ID mapping (reverse)
 */
export async function storeQbToPipedriveMapping(
  qbCustomerId: string,
  pipedriveId: string
): Promise<void> {
  const redis = getRedis();
  await redis.set(KEYS.mapQbToPipedrive(qbCustomerId), pipedriveId, { ex: TTL.mapping });
  logger.debug('Stored QB->Pipedrive mapping', { qbCustomerId, pipedriveId });
}

/**
 * Get Pipedrive Person ID from QuickBooks Customer ID
 */
export async function getPipedriveIdFromQb(qbCustomerId: string): Promise<string | null> {
  const redis = getRedis();
  return redis.get(KEYS.mapQbToPipedrive(qbCustomerId));
}

// ============================================
// ATTRIBUTION ENGINE
// ============================================

export interface AttributionResult {
  invoiceId: string;
  invoiceNumber: string;
  customerId: string;
  customerName: string;
  invoiceAmount: number;
  invoiceDate: string; // YYYY-MM-DD
  salesRepId: number;
  salesRepName: string;
  commissionRate: number;
  commissionAmount: number;
  attributedAt: string; // ISO timestamp
  referralChain: number[]; // Person IDs in chain (for debugging)
}

/**
 * Store attribution result for an invoice
 */
export async function storeAttribution(result: AttributionResult): Promise<void> {
  const redis = getRedis();
  await redis.set(KEYS.attribution(result.invoiceId), result, { ex: TTL.attribution });
  await redis.set(KEYS.attributionProcessed(result.invoiceId), Date.now(), { ex: TTL.attribution });
  logger.debug('Stored attribution', { invoiceId: result.invoiceId, salesRep: result.salesRepName });
}

/**
 * Get attribution result for a specific invoice
 */
export async function getAttribution(invoiceId: string): Promise<AttributionResult | null> {
  const redis = getRedis();
  return redis.get<AttributionResult>(KEYS.attribution(invoiceId));
}

/**
 * Check if an invoice has already been processed
 */
export async function wasInvoiceAttributed(invoiceId: string): Promise<boolean> {
  const redis = getRedis();
  const exists = await redis.exists(KEYS.attributionProcessed(invoiceId));
  return exists === 1;
}

/**
 * Get all attribution results for a date range
 * Note: This scans keys - for production scale, consider using a sorted set index
 */
export async function getAttributionsByDateRange(
  startDate: string,
  endDate: string
): Promise<AttributionResult[]> {
  const redis = getRedis();

  // Get all attribution keys
  const keys = await redis.keys('attribution:*');

  // Filter out the "processed" keys
  const attributionKeys = keys.filter(k => !k.includes(':processed:'));

  if (attributionKeys.length === 0) {
    return [];
  }

  // Fetch all attribution records
  const results: AttributionResult[] = [];
  for (const key of attributionKeys) {
    const data = await redis.get<AttributionResult>(key);
    if (data && data.invoiceDate >= startDate && data.invoiceDate <= endDate) {
      results.push(data);
    }
  }

  // Sort by invoice date
  results.sort((a, b) => a.invoiceDate.localeCompare(b.invoiceDate));

  return results;
}
