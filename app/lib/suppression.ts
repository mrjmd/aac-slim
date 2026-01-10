/**
 * Phone suppression list management for App Router
 * Maintains lists of DNC, litigators, and opt-outs
 */

import { Redis } from '@upstash/redis'
import { toRedisPhone } from '@/src/lib/phone'

function getRedis() {
  const url = process.env.UPSTASH_REDIS_REST_URL
  const token = process.env.UPSTASH_REDIS_REST_TOKEN
  if (!url || !token) {
    throw new Error('Redis environment variables not configured')
  }
  return new Redis({ url, token })
}

const KEYS = {
  optOutPhones: 'optouts:phones',
  dncPhones: 'suppression:dnc',
  litigatorPhones: 'suppression:litigators',
  landlinePhones: 'suppression:landlines',
  inactivePhones: 'suppression:inactive',
  verifiedClean: 'cache:verified-clean', // Hash with phone -> timestamp
  // Global tracking of all phones ever sent to (across all campaigns)
  everMessaged: 'suppression:ever-messaged',
  // Full SearchBug response cache for auditing
  searchbugRaw: 'cache:searchbug-raw', // Hash with phone -> JSON response
}

// Cache TTLs
const INACTIVE_CACHE_DAYS = 90
const CLEAN_CACHE_DAYS = 60

/**
 * Normalize phone to 10 digits for consistent cache keys
 * Uses canonical toRedisPhone from src/lib/phone
 */
function normalizePhone(phone: string): string {
  return toRedisPhone(phone) || phone.replace(/\D/g, '').slice(-10)
}

/**
 * Add multiple phones to the DNC list
 */
export async function addManyToDncList(phones: string[]): Promise<void> {
  if (phones.length === 0) return
  const redis = getRedis()
  for (const phone of phones) {
    await redis.sadd(KEYS.dncPhones, normalizePhone(phone))
  }
  console.log(`Added ${phones.length} phones to DNC list`)
}

/**
 * Add multiple phones to the litigator list
 */
export async function addManyToLitigatorList(phones: string[]): Promise<void> {
  if (phones.length === 0) return
  const redis = getRedis()
  for (const phone of phones) {
    await redis.sadd(KEYS.litigatorPhones, normalizePhone(phone))
  }
  console.log(`Added ${phones.length} phones to litigator list`)
}

/**
 * Add multiple phones to the landline list (permanent - landlines don't become mobile)
 */
export async function addManyToLandlineList(phones: string[]): Promise<void> {
  if (phones.length === 0) return
  const redis = getRedis()
  for (const phone of phones) {
    await redis.sadd(KEYS.landlinePhones, normalizePhone(phone))
  }
  console.log(`Added ${phones.length} phones to landline list`)
}

/**
 * Add multiple phones to the inactive list with TTL
 */
export async function addManyToInactiveList(phones: string[]): Promise<void> {
  if (phones.length === 0) return
  const redis = getRedis()
  const timestamp = Date.now().toString()
  for (const phone of phones) {
    await redis.hset(KEYS.inactivePhones, { [normalizePhone(phone)]: timestamp })
  }
  console.log(`Added ${phones.length} phones to inactive cache`)
}

/**
 * Add multiple phones to the verified clean cache with TTL
 */
export async function addManyToVerifiedClean(phones: string[]): Promise<void> {
  if (phones.length === 0) return
  const redis = getRedis()
  const timestamp = Date.now().toString()
  for (const phone of phones) {
    await redis.hset(KEYS.verifiedClean, { [normalizePhone(phone)]: timestamp })
  }
  console.log(`Added ${phones.length} phones to verified clean cache`)
}

/**
 * SearchBug raw data structure for caching
 */
interface SearchBugCacheEntry {
  type: string // CELLULAR, VOIP, LANDLINE, UNKNOWN
  status: string // ACTIVE, INACTIVE, NOT_VERIFIED, INVALID
  dnc: string // NO, FED, state codes, CPL
  tcpa: string // YES, NO
  carrier: string
  ported: string // YES, NO
  state: string
  timestamp: number // When cached
}

/**
 * Store full SearchBug response for a batch of phones
 * Used for auditing why phones bounced or were filtered
 */
export async function cacheSearchBugResults(
  results: Array<{
    NUMBER: string
    TYPE: string
    STATUS: string
    DNC: string
    TCPA: string
    CARRIER: string
    PORTED: string
    STATE: string
  }>
): Promise<void> {
  if (results.length === 0) return
  const redis = getRedis()
  const timestamp = Date.now()

  for (const r of results) {
    const entry: SearchBugCacheEntry = {
      type: r.TYPE || 'UNKNOWN',
      status: r.STATUS || 'UNKNOWN',
      dnc: r.DNC || 'NO',
      tcpa: r.TCPA || 'NO',
      carrier: r.CARRIER || 'UNKNOWN',
      ported: r.PORTED || 'NO',
      state: r.STATE || 'UNKNOWN',
      timestamp,
    }
    await redis.hset(KEYS.searchbugRaw, { [normalizePhone(r.NUMBER)]: JSON.stringify(entry) })
  }
  console.log(`Cached ${results.length} SearchBug results for auditing`)
}

/**
 * Get cached SearchBug data for a phone (for auditing)
 */
export async function getSearchBugCache(phone: string): Promise<SearchBugCacheEntry | null> {
  const redis = getRedis()
  const raw = await redis.hget(KEYS.searchbugRaw, normalizePhone(phone))
  if (!raw) return null
  return JSON.parse(raw as string)
}

/**
 * Get cached SearchBug data for multiple phones (for auditing)
 */
export async function getSearchBugCacheBatch(phones: string[]): Promise<Map<string, SearchBugCacheEntry>> {
  const redis = getRedis()
  const results = new Map<string, SearchBugCacheEntry>()

  for (const phone of phones) {
    const normalized = normalizePhone(phone)
    const raw = await redis.hget(KEYS.searchbugRaw, normalized)
    if (raw) {
      results.set(phone, JSON.parse(raw as string))
    }
  }

  return results
}

/**
 * Check if a phone is suppressed (opt-out, DNC, litigator, or landline)
 * Returns the reason if suppressed, null if clean
 */
export async function checkSuppression(phone: string): Promise<'optout' | 'dnc' | 'litigator' | 'landline' | null> {
  const redis = getRedis()

  // Check in parallel for efficiency
  const [isOptOut, isDnc, isLit, isLandline] = await Promise.all([
    redis.sismember(KEYS.optOutPhones, phone),
    redis.sismember(KEYS.dncPhones, phone),
    redis.sismember(KEYS.litigatorPhones, phone),
    redis.sismember(KEYS.landlinePhones, phone),
  ])

  if (isLit === 1) return 'litigator'
  if (isDnc === 1) return 'dnc'
  if (isOptOut === 1) return 'optout'
  if (isLandline === 1) return 'landline'

  return null
}

/**
 * Check if a phone was recently verified as inactive (within TTL)
 */
export async function isInactiveRecent(phone: string): Promise<boolean> {
  const redis = getRedis()
  const timestamp = await redis.hget(KEYS.inactivePhones, phone)
  if (!timestamp) return false

  const age = Date.now() - parseInt(timestamp as string)
  const maxAge = INACTIVE_CACHE_DAYS * 24 * 60 * 60 * 1000
  return age < maxAge
}

/**
 * Check if a phone was recently verified as clean (within TTL)
 */
export async function isVerifiedCleanRecent(phone: string): Promise<boolean> {
  const redis = getRedis()
  const timestamp = await redis.hget(KEYS.verifiedClean, phone)
  if (!timestamp) return false

  const age = Date.now() - parseInt(timestamp as string)
  const maxAge = CLEAN_CACHE_DAYS * 24 * 60 * 60 * 1000
  return age < maxAge
}

/**
 * Suppression reasons for a phone
 */
export interface PhoneSuppressionReasons {
  optout: boolean
  dnc: boolean
  litigator: boolean
  landline: boolean
  inactive: boolean
  // Primary reason for backward compatibility (returns first found)
  primary: 'optout' | 'dnc' | 'litigator' | 'landline' | 'inactive' | null
}

/**
 * Batch check phones against all caches
 * Returns categorized results for efficient pre-filtering
 * NOTE: Returns results keyed by ORIGINAL phone format, but checks using normalized 10-digit format
 * IMPORTANT: Returns ALL suppression reasons per phone, not just the first one
 */
export async function batchCheckCache(phones: string[]): Promise<{
  suppressed: Map<string, 'optout' | 'dnc' | 'litigator' | 'landline' | 'inactive'>
  suppressedFull: Map<string, PhoneSuppressionReasons>
  verifiedClean: Set<string>
  needsScrub: string[]
}> {
  const redis = getRedis()
  const suppressed = new Map<string, 'optout' | 'dnc' | 'litigator' | 'landline' | 'inactive'>()
  const suppressedFull = new Map<string, PhoneSuppressionReasons>()
  const verifiedClean = new Set<string>()
  const needsScrub: string[] = []

  const now = Date.now()
  const inactiveMaxAge = INACTIVE_CACHE_DAYS * 24 * 60 * 60 * 1000
  const cleanMaxAge = CLEAN_CACHE_DAYS * 24 * 60 * 60 * 1000

  for (const phone of phones) {
    // Normalize to 10 digits for cache lookup
    const normalized = normalizePhone(phone)

    // Check ALL suppression lists using normalized phone
    const [isOptOut, isDnc, isLit, isLandline, inactiveTs, cleanTs] = await Promise.all([
      redis.sismember(KEYS.optOutPhones, normalized),
      redis.sismember(KEYS.dncPhones, normalized),
      redis.sismember(KEYS.litigatorPhones, normalized),
      redis.sismember(KEYS.landlinePhones, normalized),
      redis.hget(KEYS.inactivePhones, normalized),
      redis.hget(KEYS.verifiedClean, normalized),
    ])

    const isInactive = inactiveTs && (now - parseInt(inactiveTs as string)) < inactiveMaxAge
    const isClean = cleanTs && (now - parseInt(cleanTs as string)) < cleanMaxAge

    // Build full suppression reasons
    const reasons: PhoneSuppressionReasons = {
      optout: isOptOut === 1,
      dnc: isDnc === 1,
      litigator: isLit === 1,
      landline: isLandline === 1,
      inactive: !!isInactive,
      primary: null,
    }

    // Determine primary reason (priority order)
    if (isLit === 1) reasons.primary = 'litigator'
    else if (isDnc === 1) reasons.primary = 'dnc'
    else if (isOptOut === 1) reasons.primary = 'optout'
    else if (isLandline === 1) reasons.primary = 'landline'
    else if (isInactive) reasons.primary = 'inactive'

    // If ANY suppression reason exists
    if (reasons.primary) {
      suppressed.set(phone, reasons.primary)
      suppressedFull.set(phone, reasons)
      continue
    }

    // Check if verified clean
    if (isClean) {
      verifiedClean.add(phone)
      continue
    }

    // Not in any cache - needs SearchBug scrub
    needsScrub.push(phone)
  }

  return { suppressed, suppressedFull, verifiedClean, needsScrub }
}

/**
 * Get suppression list stats
 */
export async function getSuppressionStats(): Promise<{
  optouts: number
  dnc: number
  litigators: number
  everMessaged: number
}> {
  const redis = getRedis()
  const [optouts, dnc, litigators, everMessaged] = await Promise.all([
    redis.scard(KEYS.optOutPhones),
    redis.scard(KEYS.dncPhones),
    redis.scard(KEYS.litigatorPhones),
    redis.scard(KEYS.everMessaged),
  ])
  return { optouts, dnc, litigators, everMessaged }
}

/**
 * Add phones to the global "ever messaged" list
 * Should be called after successfully sending messages in a campaign
 */
export async function addManyToEverMessaged(phones: string[]): Promise<void> {
  if (phones.length === 0) return
  const redis = getRedis()
  for (const phone of phones) {
    await redis.sadd(KEYS.everMessaged, normalizePhone(phone))
  }
  console.log(`Added ${phones.length} phones to ever-messaged list`)
}

/**
 * Check if a phone has ever been messaged
 */
export async function wasEverMessaged(phone: string): Promise<boolean> {
  const redis = getRedis()
  return (await redis.sismember(KEYS.everMessaged, phone)) === 1
}

/**
 * Batch check multiple phones for ever-messaged status
 * More efficient than individual checks
 */
export async function checkManyEverMessaged(phones: string[]): Promise<Set<string>> {
  const redis = getRedis()
  const messaged = new Set<string>()

  for (const phone of phones) {
    // Check using normalized phone, but return original format
    const isMember = await redis.sismember(KEYS.everMessaged, normalizePhone(phone))
    if (isMember === 1) {
      messaged.add(phone)
    }
  }

  return messaged
}
