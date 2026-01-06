/**
 * SearchBug Bulk Phone Validation API Client
 *
 * Used for scrubbing phone lists before SMS campaigns:
 * - DNC (Federal + State + Complainers)
 * - TCPA Litigators
 * - Line type (Landline vs Cellular)
 * - Active/Disconnected status
 */

export interface PhoneValidationRequest {
  id: string
  phone: string
}

export interface PhoneValidationResult {
  ID: string
  NUMBER: string
  STATUS: 'ACTIVE' | 'INACTIVE' | 'INVALID' | 'NOT_VERIFIED'
  DNC: string // 'NO', 'FED', state codes, 'CPL', or combinations
  TCPA: 'YES' | 'NO'
  TYPE: 'LANDLINE' | 'CELLULAR' | 'VOIP' | 'UNKNOWN'
  OCN: string
  PORTED: 'YES' | 'NO'
  CARRIER: string
  SMSEMAIL: string
  LOCATION: string
  STATE: string
  TIMEZONE: string
}

export interface SendResponse {
  SUCCESS: boolean
  KEY?: string
  TYPE?: string
  RECORDS?: string
  TIME?: number // Expected minutes, 0/null = <1 minute
  PRICE?: string
  PAYMENT_ID?: string
  ERROR?: string
}

export interface ReceiveResponse {
  STATUS: 'Running' | 'Complete' | 'Stopped' | 'Failed'
  // When running:
  PROCESSED?: string
  PERCENT?: string
  TOFINISH?: string
  MINLEFT?: string
  // When complete:
  DATA?: PhoneValidationResult[]
  // When failed:
  ERROR?: string
}

export interface ScrubResult {
  clean: PhoneValidationResult[]
  removed: {
    dnc: PhoneValidationResult[]
    litigator: PhoneValidationResult[]
    landline: PhoneValidationResult[]
    inactive: PhoneValidationResult[]
  }
  summary: {
    total: number
    clean: number
    dnc: number
    litigator: number
    landline: number
    inactive: number
  }
}

function getCredentials() {
  const coCode = process.env.SEARCHBUG_CO_CODE
  const pass = process.env.SEARCHBUG_API_KEY

  if (!coCode || !pass) {
    throw new Error('SearchBug credentials not configured (SEARCHBUG_CO_CODE, SEARCHBUG_API_KEY)')
  }

  return { coCode, pass }
}

/**
 * Format phone number to SearchBug's expected format: (XXX) XXX-XXXX
 * Input can be: +16467564126, 16467564126, 6467564126, etc.
 */
function formatPhoneForSearchBug(phone: string): string {
  // Strip all non-digits
  const digits = phone.replace(/\D/g, '')

  // Remove leading 1 if 11 digits (US country code)
  const tenDigits = digits.length === 11 && digits.startsWith('1')
    ? digits.slice(1)
    : digits

  // Format as (XXX) XXX-XXXX
  if (tenDigits.length === 10) {
    return `(${tenDigits.slice(0, 3)}) ${tenDigits.slice(3, 6)}-${tenDigits.slice(6)}`
  }

  // Return as-is if not 10 digits (let SearchBug handle validation)
  return phone
}

/**
 * Sleep helper for retry logic
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Submit a batch of phone numbers for validation
 * Returns a KEY to poll for results
 * Includes retry logic for transient errors
 */
export async function submitPhoneBatch(
  phones: PhoneValidationRequest[],
  maxRetries: number = 3
): Promise<{ key: string; estimatedMinutes: number }> {
  const { coCode, pass } = getCredentials()

  // Format phones to SearchBug's expected format
  const formattedPhones = phones.map(p => ({
    id: p.id,
    phone: formatPhoneForSearchBug(p.phone),
  }))

  let lastError: Error | null = null

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const params = new URLSearchParams({
        co_code: coCode,
        pass: pass,
        type: 'batch_lnd', // Advanced: DNC + TCPA + line type
        format: 'JSON',
      })

      const response = await fetch(`https://bulk.searchbug.com/c/api/send?${params}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(formattedPhones),
      })

      if (!response.ok) {
        throw new Error(`SearchBug API error: ${response.status} ${response.statusText}`)
      }

      const data: SendResponse = await response.json()

      if (!data.SUCCESS) {
        // Check if it's a transient server error (internal errors often contain these strings)
        const errorMsg = data.ERROR || 'Unknown error'
        const isServerError = errorMsg.includes('Unable to cast') ||
                              errorMsg.includes('System.') ||
                              errorMsg.includes('Exception')

        if (isServerError && attempt < maxRetries) {
          console.warn(`SearchBug server error (attempt ${attempt}/${maxRetries}): ${errorMsg}`)
          lastError = new Error(errorMsg)
          await sleep(2000 * attempt) // Exponential backoff
          continue
        }

        throw new Error(`SearchBug validation failed: ${errorMsg}`)
      }

      if (!data.KEY) {
        throw new Error('SearchBug did not return a batch KEY')
      }

      return {
        key: data.KEY,
        estimatedMinutes: data.TIME || 1,
      }
    } catch (error) {
      lastError = error as Error

      // Retry on network errors
      if (attempt < maxRetries && (error as Error).message.includes('fetch')) {
        console.warn(`SearchBug network error (attempt ${attempt}/${maxRetries}):`, error)
        await sleep(2000 * attempt)
        continue
      }

      throw error
    }
  }

  throw lastError || new Error('SearchBug submission failed after retries')
}

/**
 * Poll for batch validation results
 */
export async function getValidationResults(
  key: string
): Promise<ReceiveResponse> {
  const { coCode, pass } = getCredentials()

  // Note: receive endpoint uses headers, not query params (unlike send)
  const response = await fetch('https://bulk.searchbug.com/c/api/receive', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'CO_CODE': coCode,
      'PASS': pass,
      'KEY': key,
      'FORMAT': 'JSON',
    },
    body: '[]', // Empty array body required
  })

  if (!response.ok) {
    throw new Error(`SearchBug API error: ${response.status} ${response.statusText}`)
  }

  return response.json()
}

/**
 * Wait for batch validation to complete with polling
 */
export async function waitForValidation(
  key: string,
  onProgress?: (percent: string, minutesLeft: string) => void,
  maxWaitMs: number = 10 * 60 * 1000 // 10 minutes default
): Promise<PhoneValidationResult[]> {
  const startTime = Date.now()
  const pollInterval = 3000 // 3 seconds

  while (Date.now() - startTime < maxWaitMs) {
    const result = await getValidationResults(key)

    if (result.STATUS === 'Complete') {
      return result.DATA || []
    }

    if (result.STATUS === 'Failed' || result.STATUS === 'Stopped') {
      throw new Error(`SearchBug validation ${result.STATUS}: ${result.ERROR || 'Unknown error'}`)
    }

    // Still running
    if (onProgress && result.PERCENT && result.MINLEFT) {
      onProgress(result.PERCENT, result.MINLEFT)
    }

    await new Promise(resolve => setTimeout(resolve, pollInterval))
  }

  throw new Error('SearchBug validation timed out')
}

/**
 * Filter validation results into clean and removed categories
 */
export function filterResults(results: PhoneValidationResult[]): ScrubResult {
  const clean: PhoneValidationResult[] = []
  const removed = {
    dnc: [] as PhoneValidationResult[],
    litigator: [] as PhoneValidationResult[],
    landline: [] as PhoneValidationResult[],
    inactive: [] as PhoneValidationResult[],
  }

  for (const result of results) {
    // Check in priority order (a number can fail multiple checks)

    // TCPA litigator - highest priority removal
    if (result.TCPA === 'YES') {
      removed.litigator.push(result)
      continue
    }

    // DNC list (Federal, State, or Complainer)
    if (result.DNC !== 'NO') {
      removed.dnc.push(result)
      continue
    }

    // Landline - can't receive SMS
    if (result.TYPE === 'LANDLINE') {
      removed.landline.push(result)
      continue
    }

    // Only remove confirmed bad numbers
    // INACTIVE = confirmed disconnected
    // INVALID = bad phone format
    // NOT_VERIFIED = couldn't verify - these are usually fine, let them through
    if (result.STATUS === 'INACTIVE' || result.STATUS === 'INVALID') {
      removed.inactive.push(result)
      continue
    }

    // Passed all checks
    clean.push(result)
  }

  return {
    clean,
    removed,
    summary: {
      total: results.length,
      clean: clean.length,
      dnc: removed.dnc.length,
      litigator: removed.litigator.length,
      landline: removed.landline.length,
      inactive: removed.inactive.length,
    },
  }
}

/**
 * Full scrub workflow: submit, wait, filter
 */
export async function scrubPhoneList(
  phones: PhoneValidationRequest[],
  onProgress?: (percent: string, minutesLeft: string) => void
): Promise<ScrubResult> {
  // Submit batch
  const { key } = await submitPhoneBatch(phones)

  // Wait for completion
  const results = await waitForValidation(key, onProgress)

  // Filter results
  return filterResults(results)
}
