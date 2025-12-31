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
  /** Campaign data */
  campaign: (campaignId: string) => `campaign:${campaignId}`,
  /** Set of phone numbers in a campaign */
  campaignContacts: (campaignId: string) => `campaign:${campaignId}:contacts`,
  /** Set of active campaign IDs */
  campaignsActive: () => 'campaigns:active',
  /** Global opt-out list */
  optOutPhones: () => 'optouts:phones',
} as const;

// TTLs in seconds
const TTL = {
  dedupe: 86400, // 24 hours
  mapping: 604800, // 7 days
  loopPrevention: 60, // 1 minute - just long enough to catch the webhook
  attribution: 31536000, // 1 year - keep attribution records long-term
  campaign: 7776000, // 90 days - keep campaign data for 3 months
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

// ============================================
// CAMPAIGN MANAGER
// ============================================

export interface CampaignStats {
  total: number;      // Total contacts in campaign
  queued: number;     // Messages queued
  skipped: number;    // Skipped (already contacted)
  sent: number;       // Successfully sent
  failed: number;     // Failed to send
  responses: number;  // Inbound responses
  optOuts: number;    // Opt-outs detected
}

export interface CampaignVariant {
  id: string;         // 'A', 'B', 'C', 'D'
  message: string;    // The message template for this variant
  weight: number;     // 0-100, all weights must sum to 100
  stats: {
    sent: number;
    responses: number;
    optOuts: number;
  };
}

export interface Campaign {
  id: string;
  name: string;
  status: 'pending' | 'running' | 'paused' | 'completed';
  messageTemplate: string;  // Default template (used if no variants)
  variants?: CampaignVariant[];  // Optional A/B test variants
  createdAt: string; // ISO timestamp
  stats: CampaignStats;
}

/**
 * Create a new campaign
 */
export async function createCampaign(
  id: string,
  name: string,
  messageTemplate: string,
  variants?: Array<{ id: string; message: string; weight: number }>
): Promise<Campaign> {
  const redis = getRedis();

  // Initialize variant stats if variants provided
  const campaignVariants: CampaignVariant[] | undefined = variants?.map(v => ({
    ...v,
    stats: { sent: 0, responses: 0, optOuts: 0 },
  }));

  const campaign: Campaign = {
    id,
    name,
    status: 'pending',
    messageTemplate,
    variants: campaignVariants,
    createdAt: new Date().toISOString(),
    stats: {
      total: 0,
      queued: 0,
      skipped: 0,
      sent: 0,
      failed: 0,
      responses: 0,
      optOuts: 0,
    },
  };

  await redis.set(KEYS.campaign(id), campaign, { ex: TTL.campaign });
  await redis.sadd(KEYS.campaignsActive(), id);

  logger.info('Created campaign', { id, name, variantCount: variants?.length || 0 });
  return campaign;
}

/**
 * Select a variant based on weighted random selection
 */
export function selectVariant(variants: CampaignVariant[]): CampaignVariant {
  const totalWeight = variants.reduce((sum, v) => sum + v.weight, 0);
  let random = Math.random() * totalWeight;

  for (const variant of variants) {
    random -= variant.weight;
    if (random <= 0) {
      return variant;
    }
  }

  // Fallback to first variant (shouldn't happen)
  return variants[0];
}

/**
 * Increment variant-specific stats
 */
export async function incrementVariantStats(
  campaignId: string,
  variantId: string,
  updates: Partial<CampaignVariant['stats']>
): Promise<void> {
  const redis = getRedis();
  const campaign = await getCampaign(campaignId);
  if (!campaign || !campaign.variants) {
    return;
  }

  const variant = campaign.variants.find(v => v.id === variantId);
  if (!variant) {
    return;
  }

  // Apply increments to variant stats
  for (const [key, value] of Object.entries(updates)) {
    if (value !== undefined) {
      variant.stats[key as keyof CampaignVariant['stats']] += value;
    }
  }

  await redis.set(KEYS.campaign(campaignId), campaign, { ex: TTL.campaign });
}

/**
 * Get campaign by ID
 */
export async function getCampaign(id: string): Promise<Campaign | null> {
  const redis = getRedis();
  return redis.get<Campaign>(KEYS.campaign(id));
}

/**
 * Update campaign status
 */
export async function updateCampaignStatus(
  id: string,
  status: Campaign['status']
): Promise<void> {
  const redis = getRedis();
  const campaign = await getCampaign(id);
  if (!campaign) {
    throw new Error(`Campaign not found: ${id}`);
  }

  campaign.status = status;
  await redis.set(KEYS.campaign(id), campaign, { ex: TTL.campaign });

  // Remove from active set if completed
  if (status === 'completed') {
    await redis.srem(KEYS.campaignsActive(), id);
  }

  logger.info('Updated campaign status', { id, status });
}

/**
 * Increment campaign stats
 */
export async function incrementCampaignStats(
  id: string,
  updates: Partial<CampaignStats>
): Promise<void> {
  const redis = getRedis();
  const campaign = await getCampaign(id);
  if (!campaign) {
    throw new Error(`Campaign not found: ${id}`);
  }

  // Apply increments
  for (const [key, value] of Object.entries(updates)) {
    if (value !== undefined) {
      campaign.stats[key as keyof CampaignStats] += value;
    }
  }

  await redis.set(KEYS.campaign(id), campaign, { ex: TTL.campaign });
}

/**
 * Add a phone to the campaign's contact set
 */
export async function addCampaignContact(
  campaignId: string,
  phone: string,
  variant?: string
): Promise<void> {
  const redis = getRedis();
  // Store phone:variant mapping for response tracking
  const value = variant ? `${phone}:${variant}` : phone;
  await redis.sadd(KEYS.campaignContacts(campaignId), value);
}

/**
 * Check if a phone is part of a campaign
 */
export async function isPhoneInCampaign(
  campaignId: string,
  phone: string
): Promise<{ inCampaign: boolean; variant?: string }> {
  const redis = getRedis();
  const members = await redis.smembers(KEYS.campaignContacts(campaignId));

  for (const member of members) {
    if (member.startsWith(phone)) {
      const parts = member.split(':');
      return { inCampaign: true, variant: parts[1] };
    }
  }

  return { inCampaign: false };
}

/**
 * Add phone to global opt-out list
 */
export async function addOptOut(phone: string): Promise<void> {
  const redis = getRedis();
  await redis.sadd(KEYS.optOutPhones(), phone);
  logger.info('Added opt-out', { phone });
}

/**
 * Check if phone is in opt-out list
 */
export async function isOptedOut(phone: string): Promise<boolean> {
  const redis = getRedis();
  return (await redis.sismember(KEYS.optOutPhones(), phone)) === 1;
}

/**
 * Get all active campaigns
 */
export async function getActiveCampaigns(): Promise<Campaign[]> {
  const redis = getRedis();
  const ids = await redis.smembers(KEYS.campaignsActive());

  const campaigns: Campaign[] = [];
  for (const id of ids) {
    const campaign = await getCampaign(id);
    if (campaign) {
      campaigns.push(campaign);
    }
  }

  return campaigns;
}

/**
 * Find which campaign (if any) a phone number belongs to
 * Searches all active campaigns
 */
export async function findCampaignForPhone(
  phone: string
): Promise<{ campaign: Campaign; variant?: string } | null> {
  const campaigns = await getActiveCampaigns();

  for (const campaign of campaigns) {
    const result = await isPhoneInCampaign(campaign.id, phone);
    if (result.inCampaign) {
      return { campaign, variant: result.variant };
    }
  }

  return null;
}

/**
 * Opt-out keywords (case-insensitive, whole word)
 */
export const OPT_OUT_KEYWORDS = ['STOP', 'CANCEL', 'UNSUBSCRIBE', 'QUIT', 'END'];

/**
 * Check if a message contains an opt-out keyword
 */
export function isOptOutMessage(message: string): boolean {
  const upperMessage = message.toUpperCase().trim();
  return OPT_OUT_KEYWORDS.some(keyword => {
    // Match whole word only
    const regex = new RegExp(`\\b${keyword}\\b`);
    return regex.test(upperMessage);
  });
}

// ============================================
// HEALTH MONITORING
// ============================================

/**
 * Track a webhook processing event for health monitoring
 */
export async function trackWebhookProcessed(
  source: 'pipedrive' | 'quo' | 'google-ads'
): Promise<void> {
  const redis = getRedis();
  const today = new Date().toISOString().split('T')[0];
  const now = new Date().toISOString();

  await Promise.all([
    redis.incr(`webhooks:${source}:${today}:count`),
    redis.set(`webhooks:${source}:last`, now),
    // Set TTL of 48 hours on the count key
    redis.expire(`webhooks:${source}:${today}:count`, 172800),
  ]);
}

/**
 * Log an error to Redis for health dashboard
 */
export async function logHealthError(
  source: string,
  message: string,
  details?: string
): Promise<void> {
  const redis = getRedis();
  const error = JSON.stringify({
    timestamp: new Date().toISOString(),
    source,
    message,
    details,
  });

  // Push to list, keep only last 100 errors
  await redis.lpush('health:errors', error);
  await redis.ltrim('health:errors', 0, 99);
}
