/**
 * OpenPhone API client for App Router
 * Used for checking conversation history (free pre-filter before SearchBug)
 */

const QUO_API_BASE = 'https://api.openphone.com/v1'

// Cache for phone number ID lookup
let cachedPhoneNumberId: string | null = null

function getConfig() {
  const apiKey = process.env.QUO_API_KEY
  const phoneNumber = process.env.QUO_PHONE_NUMBER

  if (!apiKey || !phoneNumber) {
    throw new Error('OpenPhone environment variables not configured (QUO_API_KEY, QUO_PHONE_NUMBER)')
  }

  return { apiKey, phoneNumber }
}

interface QuoMessage {
  id: string
  to: string[]
  from: string
  text: string
  phoneNumberId: string
  direction: 'incoming' | 'outgoing'
  status: 'queued' | 'sent' | 'delivered' | 'undelivered'
  createdAt: string
  updatedAt: string
}

interface QuoPhoneNumber {
  id: string
  number: string
  formattedNumber: string
  name: string
  createdAt: string
  updatedAt: string
}

/**
 * Make an authenticated request to OpenPhone API
 */
async function quoRequest<T>(
  endpoint: string,
  options: RequestInit = {}
): Promise<T> {
  const { apiKey } = getConfig()
  const url = `${QUO_API_BASE}${endpoint}`

  const response = await fetch(url, {
    ...options,
    headers: {
      'Authorization': apiKey,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  })

  if (!response.ok) {
    const error = await response.text()
    console.error('OpenPhone API error:', { endpoint, status: response.status, error })
    throw new Error(`OpenPhone API error: ${response.status} - ${error}`)
  }

  if (response.status === 204) {
    return {} as T
  }

  return response.json() as Promise<T>
}

/**
 * Get the phone number ID for our OpenPhone number
 * Required for the messages API to check conversation history
 */
async function getPhoneNumberId(): Promise<string> {
  if (cachedPhoneNumberId) {
    return cachedPhoneNumberId
  }

  const { phoneNumber } = getConfig()

  const result = await quoRequest<{ data: QuoPhoneNumber[] }>('/phone-numbers')
  const match = result.data?.find((pn) => pn.number === phoneNumber)

  if (!match) {
    throw new Error(`Could not find phone number ID for ${phoneNumber}`)
  }

  cachedPhoneNumberId = match.id
  return match.id
}

/**
 * Ensure phone is in E.164 format with + prefix
 */
function ensureE164(phone: string): string {
  // Already has + prefix
  if (phone.startsWith('+')) {
    return phone
  }
  // Add + prefix (assume it's already country code + number)
  return `+${phone}`
}

export interface ConversationCheckResult {
  hasConversation: boolean
  error?: string
}

/**
 * Check if we have any existing conversation history with a phone number
 * Used for deduplication - to avoid re-contacting people we've already messaged
 * @param phone - Phone number to check (will be normalized to E.164)
 * @param retries - Number of retries on rate limit (default 3)
 * @returns Object with hasConversation boolean and optional error string
 */
export async function hasExistingConversation(phone: string, retries: number = 3): Promise<ConversationCheckResult> {
  try {
    const phoneNumberId = await getPhoneNumberId()
    const e164Phone = ensureE164(phone)

    const params = new URLSearchParams({
      phoneNumberId,
      'participants[]': e164Phone,
      maxResults: '1',
    })

    const result = await quoRequest<{ data: QuoMessage[]; totalItems?: number }>(
      `/messages?${params.toString()}`
    )

    const hasMessages = (result.totalItems ?? 0) > 0 || (result.data?.length ?? 0) > 0

    return { hasConversation: hasMessages }
  } catch (error) {
    const errorMsg = (error as Error).message || ''

    // If rate limited (429), wait and retry
    if (errorMsg.includes('429') && retries > 0) {
      const waitTime = (4 - retries) * 2000 // 2s, 4s, 6s backoff
      console.log(`Rate limited on ${phone}, waiting ${waitTime}ms before retry (${retries} retries left)`)
      await sleep(waitTime)
      return hasExistingConversation(phone, retries - 1)
    }

    console.error('Failed to check conversation history:', error, { phone })
    // Return error info so caller can decide what to do
    return { hasConversation: false, error: errorMsg || 'Unknown error' }
  }
}

/**
 * Sleep helper for rate limiting
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export interface BatchConversationResult {
  hasConversation: Set<string>
  errorCount: number
  errors: Array<{ phone: string; error: string }>
}

/**
 * Batch check multiple phones for existing conversations
 * Note: This makes individual API calls since OpenPhone doesn't support batch queries
 * Uses conservative rate limiting to avoid 429 errors
 */
export async function checkManyConversations(
  phones: string[],
  options: { concurrency?: number; delayMs?: number } = {}
): Promise<BatchConversationResult> {
  // Very conservative defaults to avoid rate limiting
  const { concurrency = 2, delayMs = 500 } = options
  const hasConversation = new Set<string>()
  const errors: Array<{ phone: string; error: string }> = []

  // Process in small batches with delays to avoid overwhelming the API
  for (let i = 0; i < phones.length; i += concurrency) {
    const batch = phones.slice(i, i + concurrency)
    const results = await Promise.all(
      batch.map(async (phone) => {
        const result = await hasExistingConversation(phone)
        return { phone, ...result }
      })
    )

    for (const { phone, hasConversation: has, error } of results) {
      if (error) {
        errors.push({ phone, error })
      } else if (has) {
        hasConversation.add(phone)
      }
    }

    // Add delay between batches to respect rate limits
    if (i + concurrency < phones.length) {
      await sleep(delayMs)
    }
  }

  return { hasConversation, errorCount: errors.length, errors }
}
