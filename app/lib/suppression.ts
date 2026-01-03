/**
 * Phone suppression list management for App Router
 * Maintains lists of DNC, litigators, and opt-outs
 */

import { Redis } from '@upstash/redis'

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
  // Global tracking of all phones ever sent to (across all campaigns)
  everMessaged: 'suppression:ever-messaged',
}

/**
 * Add multiple phones to the DNC list
 */
export async function addManyToDncList(phones: string[]): Promise<void> {
  if (phones.length === 0) return
  const redis = getRedis()
  for (const phone of phones) {
    await redis.sadd(KEYS.dncPhones, phone)
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
    await redis.sadd(KEYS.litigatorPhones, phone)
  }
  console.log(`Added ${phones.length} phones to litigator list`)
}

/**
 * Check if a phone is suppressed (opt-out, DNC, or litigator)
 * Returns the reason if suppressed, null if clean
 */
export async function checkSuppression(phone: string): Promise<'optout' | 'dnc' | 'litigator' | null> {
  const redis = getRedis()

  // Check in parallel for efficiency
  const [isOptOut, isDnc, isLit] = await Promise.all([
    redis.sismember(KEYS.optOutPhones, phone),
    redis.sismember(KEYS.dncPhones, phone),
    redis.sismember(KEYS.litigatorPhones, phone),
  ])

  if (isLit === 1) return 'litigator'
  if (isDnc === 1) return 'dnc'
  if (isOptOut === 1) return 'optout'

  return null
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
    await redis.sadd(KEYS.everMessaged, phone)
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
    const isMember = await redis.sismember(KEYS.everMessaged, phone)
    if (isMember === 1) {
      messaged.add(phone)
    }
  }

  return messaged
}
