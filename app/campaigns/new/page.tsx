'use client'

import { useState, useCallback, useEffect, Suspense } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import Link from 'next/link'

interface PreviewContact {
  phone: string
  name: string
  city: string
  message: string
  variant?: string
}

interface CreateResult {
  success: boolean
  dryRun: boolean
  campaignId: string
  processed: number
  queued: number
  skipped: number
  pipedriveCreated: number
  variantCounts: Record<string, number>
  preview: PreviewContact[]
  estimatedMinutes: number
  // Multi-day campaign fields
  isMultiDay?: boolean
  totalDays?: number
  dailyLimit?: number
  batchSize?: number
  remainingContacts?: number
  nextBatchAt?: string
  estimatedTotalDays?: number
}

interface ScrubSummary {
  total: number
  clean: number
  dnc: number
  litigator: number
  landline: number
  inactive: number
}

interface PreFilterStats {
  original: number
  removed: {
    optout: number
    dnc: number
    litigator: number
    previousCampaign: number
    openphoneHistory: number
  }
  remaining: number
}

interface CleanContact {
  id: string
  phone: string
  carrier: string
  type: string
  state: string
}

interface RemovedContact {
  id: string
  phone: string
  reason: string
}

interface ScrubResult {
  status: 'complete'
  summary: ScrubSummary
  clean: CleanContact[]
  removed: {
    dnc: RemovedContact[]
    litigator: RemovedContact[]
    landline: RemovedContact[]
    inactive: RemovedContact[]
  }
}

interface ParsedContact {
  id: string
  phone: string
  firstName: string
  lastName: string | null
  city: string
  subdivision: string | null
  address: string | null
  zip: string | null
  email: string | null
}

function CharacterCounter({ length }: { length: number }) {
  const segments = Math.ceil(length / 153) || 1
  let colorClass = 'text-gray-600'
  let warning = ''

  if (length > 1600) {
    colorClass = 'text-red-600 font-semibold'
    warning = ' - exceeds limit!'
  } else if (length > 320) {
    colorClass = 'text-orange-600 font-medium'
    warning = ' - long message'
  } else if (length > 160) {
    colorClass = 'text-amber-600'
    warning = ` - ${segments} segments`
  } else if (length > 100) {
    colorClass = 'text-amber-600'
    warning = ' - consider shorter'
  }

  return (
    <p className={`text-sm ${colorClass}`}>
      {length}/1600{warning}
    </p>
  )
}

// Parse a CSV line properly handling quoted fields
function parseCSVLine(line: string): string[] {
  const result: string[] = []
  let current = ''
  let inQuotes = false

  for (let i = 0; i < line.length; i++) {
    const char = line[i]

    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        // Escaped quote
        current += '"'
        i++
      } else {
        // Toggle quote state
        inQuotes = !inQuotes
      }
    } else if (char === ',' && !inQuotes) {
      result.push(current.trim())
      current = ''
    } else {
      current += char
    }
  }

  result.push(current.trim())
  return result
}

// Parse CSV and extract contacts with phone numbers
function parseCSVToContacts(csvContent: string): ParsedContact[] {
  const lines = csvContent.split('\n')
  if (lines.length < 2) return []

  const headers = parseCSVLine(lines[0])
  const contacts: ParsedContact[] = []

  const getCol = (row: string[], name: string) => {
    const idx = headers.indexOf(name)
    return idx >= 0 ? row[idx]?.trim() || '' : ''
  }

  const normalizePhone = (phone: string): string | null => {
    if (!phone) return null
    const digits = phone.replace(/\D/g, '')
    if (digits.length === 10) return `+1${digits}`
    if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`
    if (digits.length > 10 && digits.length <= 15) return `+${digits}`
    return null
  }

  const normalizeName = (fullName: string): { firstName: string; lastName: string | null } => {
    if (!fullName?.trim()) return { firstName: 'Homeowner', lastName: null }
    const parts = fullName.trim().split(/\s+/)
    const titleCase = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase()
    if (parts.length === 1) return { firstName: titleCase(parts[0]), lastName: null }
    return { firstName: titleCase(parts[0]), lastName: parts.slice(1).map(titleCase).join(' ') }
  }

  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue

    const row = parseCSVLine(lines[i])

    // Primary contact
    const primaryPhone = getCol(row, 'Primary Mobile Phone1')
    const primaryStatus = getCol(row, 'Primary Mobile 1 Status')

    if (primaryPhone && (!primaryStatus || primaryStatus.toLowerCase() === 'active')) {
      const normalized = normalizePhone(primaryPhone)
      if (normalized) {
        const { firstName, lastName } = normalizeName(getCol(row, 'Primary Name'))
        contacts.push({
          id: `${i}-primary`,
          phone: normalized,
          firstName,
          lastName,
          city: getCol(row, 'City') || 'Unknown',
          subdivision: getCol(row, 'Subdivision') || null,
          address: getCol(row, 'Address') || null,
          zip: getCol(row, 'ZIP') || null,
          email: getCol(row, 'Primary Email1') || null,
        })
      }
    }

    // Secondary contact
    const secondaryPhone = getCol(row, 'Secondary Mobile Phone1')
    if (secondaryPhone) {
      const normalized = normalizePhone(secondaryPhone)
      if (normalized) {
        const { firstName, lastName } = normalizeName(getCol(row, 'Secondary Name'))
        contacts.push({
          id: `${i}-secondary`,
          phone: normalized,
          firstName,
          lastName,
          city: getCol(row, 'City') || 'Unknown',
          subdivision: getCol(row, 'Subdivision') || null,
          address: getCol(row, 'Address') || null,
          zip: getCol(row, 'ZIP') || null,
          email: null,
        })
      }
    }
  }

  return contacts
}

function NewCampaignPageContent() {
  const router = useRouter()
  const searchParams = useSearchParams()

  // NEW FLOW: upload -> message -> preview -> scrub
  const [step, setStep] = useState<'upload' | 'message' | 'preview' | 'scrub' | 'launching'>('upload')

  // Draft state
  const [draftId, setDraftId] = useState<string | null>(null)
  const [savingDraft, setSavingDraft] = useState(false)
  const [draftSavedAt, setDraftSavedAt] = useState<string | null>(null)

  // Form state
  const [name, setName] = useState('')
  const [csvFileName, setCsvFileName] = useState('')
  const [csvData, setCsvData] = useState('') // Store raw CSV for drafts
  const [message, setMessage] = useState('')
  const [isABTest, setIsABTest] = useState(false)
  const [messageA, setMessageA] = useState('')
  const [messageB, setMessageB] = useState('')
  const [skipDedup, setSkipDedup] = useState(false)
  const [scheduleEnabled, setScheduleEnabled] = useState(false)
  const [scheduledDate, setScheduledDate] = useState('')
  const [scheduledTime, setScheduledTime] = useState('')
  const [followUpEnabled, setFollowUpEnabled] = useState(false)
  const [followUpDays, setFollowUpDays] = useState(3)
  const [followUpMessage, setFollowUpMessage] = useState('')

  // Dev mode - skip scrub for testing
  const [devModeSkipScrub, setDevModeSkipScrub] = useState(false)

  // Parsed contacts from CSV
  const [parsedContacts, setParsedContacts] = useState<ParsedContact[]>([])

  // Scrub state
  const [scrubKey, setScrubKey] = useState<string | null>(null)
  const [scrubProgress, setScrubProgress] = useState<string>('')
  const [scrubResult, setScrubResult] = useState<ScrubResult | null>(null)
  const [cleanContacts, setCleanContacts] = useState<ParsedContact[]>([])
  const [preFilterStats, setPreFilterStats] = useState<PreFilterStats | null>(null)
  const [preFilteredPhones, setPreFilteredPhones] = useState<Array<{id: string, phone: string}> | null>(null)
  const [scrubStarted, setScrubStarted] = useState(false)

  // Preview/result state
  const [previewResult, setPreviewResult] = useState<CreateResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const handleFileUpload = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    setCsvFileName(file.name)

    const reader = new FileReader()
    reader.onload = (event) => {
      const content = event.target?.result as string
      setCsvData(content) // Store raw CSV for drafts
      const contacts = parseCSVToContacts(content)
      setParsedContacts(contacts)

      if (!name) {
        const baseName = file.name.replace(/\.csv$/i, '')
        const date = new Date().toISOString().split('T')[0]
        setName(`${date}-${baseName}`)
      }
    }
    reader.readAsText(file)
  }, [name])

  // Load draft from URL parameter on mount
  useEffect(() => {
    const draftIdParam = searchParams.get('draft')
    if (draftIdParam) {
      loadDraft(draftIdParam)
    }
  }, [searchParams])

  // Load a draft by ID
  const loadDraft = async (id: string) => {
    try {
      const res = await fetch(`/api/campaign/draft?id=${id}`)
      if (!res.ok) {
        throw new Error('Draft not found')
      }
      const draft = await res.json()

      setDraftId(draft.id)
      setName(draft.name)
      setCsvData(draft.csvData)
      setCsvFileName(`${draft.name}.csv (draft)`)

      // Parse CSV data
      if (draft.csvData) {
        const contacts = parseCSVToContacts(draft.csvData)
        setParsedContacts(contacts)
      }

      setMessage(draft.message || '')
      setMessageA(draft.messageA || '')
      setMessageB(draft.messageB || '')
      setIsABTest(draft.isABTest || false)
      setSkipDedup(draft.skipDedup || false)
      setFollowUpEnabled(draft.followUpEnabled || false)
      setFollowUpDays(draft.followUpDays || 3)
      setFollowUpMessage(draft.followUpMessage || '')
      setScheduleEnabled(draft.scheduleEnabled || false)
      setScheduledDate(draft.scheduledDate || '')
      setScheduledTime(draft.scheduledTime || '')

      // Go to message step if we have contacts
      if (draft.csvData && draft.contactCount > 0) {
        setStep('message')
      }
    } catch (err) {
      console.error('Failed to load draft:', err)
      setError('Failed to load draft')
    }
  }

  // Save current state as draft
  const saveDraft = async () => {
    setSavingDraft(true)
    try {
      const res = await fetch('/api/campaign/draft', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: draftId,
          name: name || 'Untitled Draft',
          csvData,
          contactCount: parsedContacts.length,
          message,
          messageA,
          messageB,
          isABTest,
          skipDedup,
          followUpEnabled,
          followUpDays,
          followUpMessage,
          scheduleEnabled,
          scheduledDate,
          scheduledTime,
        }),
      })

      const data = await res.json()
      if (!res.ok) {
        throw new Error(data.error || 'Failed to save draft')
      }

      setDraftId(data.draft.id)
      setDraftSavedAt(new Date().toLocaleTimeString())

      // Update URL without navigation
      window.history.replaceState({}, '', `/campaigns/new?draft=${data.draft.id}`)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSavingDraft(false)
    }
  }

  // Build CSV from contacts
  function buildCSV(contacts: ParsedContact[]): string {
    const headers = [
      'Primary Name',
      'Primary Mobile Phone1',
      'Primary Mobile 1 Status',
      'Primary Email1',
      'City',
      'Subdivision',
      'Address',
      'ZIP',
    ]

    const rows = contacts.map(c => [
      `${c.firstName} ${c.lastName || ''}`.trim(),
      c.phone.replace('+1', ''),
      'Active',
      c.email || '',
      c.city,
      c.subdivision || '',
      c.address || '',
      c.zip || '',
    ])

    return [headers.join(','), ...rows.map(r => r.join(','))].join('\n')
  }

  // Preview campaign (dry run) - uses all parsed contacts before scrub
  const runPreview = async () => {
    setLoading(true)
    setError(null)

    try {
      const csvData = buildCSV(parsedContacts)

      const res = await fetch('/api/campaign/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          csvData,
          message: isABTest ? undefined : message,
          messageA: isABTest ? messageA : undefined,
          messageB: isABTest ? messageB : undefined,
          dryRun: true,
          skipDedup,
          followUp: followUpEnabled ? {
            delayDays: followUpDays,
            message: followUpMessage,
          } : undefined,
        }),
      })

      const data = await res.json()

      if (!res.ok) {
        throw new Error(data.error || 'Failed to preview campaign')
      }

      setPreviewResult(data)
      setStep('preview')
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }

  // Start scrubbing (final step before launch)
  const startScrub = async () => {
    // Dev mode: skip scrub entirely
    if (devModeSkipScrub) {
      setCleanContacts(parsedContacts)
      setScrubResult({
        status: 'complete',
        summary: {
          total: parsedContacts.length,
          clean: parsedContacts.length,
          dnc: 0,
          litigator: 0,
          landline: 0,
          inactive: 0,
        },
        clean: parsedContacts.map(c => ({
          id: c.id,
          phone: c.phone,
          carrier: 'SKIPPED',
          type: 'SKIPPED',
          state: 'SKIPPED',
        })),
        removed: { dnc: [], litigator: [], landline: [], inactive: [] },
      })
      return
    }

    setLoading(true)
    setError(null)
    setScrubProgress('Starting phone validation...')

    try {
      const phonesToScrub = parsedContacts.map(c => ({
        id: c.id,
        phone: c.phone.replace('+', ''),
      }))

      // If we have cached pre-filtered phones, skip to SearchBug
      if (preFilteredPhones) {
        setScrubProgress('Retrying SearchBug (using cached pre-filter)...')
        await submitToSearchBug(preFilteredPhones, preFilterStats)
        return
      }

      // PHASE 1-3: Stream pre-filtering progress
      setScrubProgress('Phase 1/4: Starting pre-filter checks...')

      const prefilterRes = await fetch('/api/phones/prefilter', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phones: phonesToScrub }),
      })

      if (!prefilterRes.ok) {
        const errorData = await prefilterRes.json()
        throw new Error(errorData.error || 'Pre-filter failed')
      }

      // Read the streaming response
      const reader = prefilterRes.body?.getReader()
      if (!reader) {
        throw new Error('No response stream')
      }

      const decoder = new TextDecoder()
      let buffer = ''
      let preFilteredResult: { preFilteredPhones: Array<{id: string, phone: string}>, preFilterStats: PreFilterStats } | null = null

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })

        // Parse SSE events from buffer
        const events = buffer.split('\n\n')
        buffer = events.pop() || '' // Keep incomplete event in buffer

        for (const event of events) {
          const lines = event.split('\n')
          let eventType = ''
          let eventData = ''

          for (const line of lines) {
            if (line.startsWith('event: ')) {
              eventType = line.slice(7)
            } else if (line.startsWith('data: ')) {
              eventData = line.slice(6)
            }
          }

          if (eventType && eventData) {
            const data = JSON.parse(eventData)

            if (eventType === 'progress') {
              setScrubProgress(`Phase ${data.phase}/${data.total}: ${data.message}`)
            } else if (eventType === 'complete') {
              preFilteredResult = {
                preFilteredPhones: data.preFilteredPhones,
                preFilterStats: data.preFilterStats,
              }
              setPreFilterStats(data.preFilterStats)
              setPreFilteredPhones(data.preFilteredPhones)
            } else if (eventType === 'error') {
              throw new Error(data.message)
            }
          }
        }
      }

      if (!preFilteredResult) {
        throw new Error('Pre-filter did not complete')
      }

      // All phones were pre-filtered out
      if (preFilteredResult.preFilteredPhones.length === 0) {
        setScrubResult({
          status: 'complete',
          summary: {
            total: preFilteredResult.preFilterStats.original,
            clean: 0,
            dnc: preFilteredResult.preFilterStats.removed.dnc,
            litigator: preFilteredResult.preFilterStats.removed.litigator,
            landline: 0,
            inactive: 0,
          },
          clean: [],
          removed: { dnc: [], litigator: [], landline: [], inactive: [] },
        })
        setCleanContacts([])
        setScrubProgress('')
        setLoading(false)
        return
      }

      // PHASE 4: Submit to SearchBug
      await submitToSearchBug(preFilteredResult.preFilteredPhones, preFilteredResult.preFilterStats)

    } catch (err) {
      setError((err as Error).message)
      setScrubProgress('')
    } finally {
      setLoading(false)
    }
  }

  // Helper function to submit to SearchBug
  const submitToSearchBug = async (
    phones: Array<{id: string, phone: string}>,
    stats: PreFilterStats | null
  ) => {
    setScrubProgress(`Phase 4/4: Submitting ${phones.length} phones to SearchBug...`)

    const startRes = await fetch('/api/phones/scrub/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        preFilteredPhones: phones,
        previousPreFilterStats: stats,
      }),
    })

    const startData = await startRes.json()

    if (!startRes.ok) {
      throw new Error(startData.error || 'SearchBug submission failed')
    }

    if (!startData.key) {
      throw new Error('SearchBug did not return a batch key')
    }

    setScrubKey(startData.key)
    setScrubProgress(`SearchBug validating ${startData.count} phones (est. ${startData.estimatedMinutes} min)...`)
  }

  // Poll for scrub results
  useEffect(() => {
    if (!scrubKey || step !== 'scrub') return

    const pollInterval = setInterval(async () => {
      try {
        const res = await fetch('/api/phones/scrub/status', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key: scrubKey }),
        })

        const data = await res.json()

        if (data.status === 'running') {
          setScrubProgress(`Validating... ${data.percent || '0%'} (${data.minutesLeft || '?'} min left)`)
        } else if (data.status === 'complete') {
          clearInterval(pollInterval)
          setScrubResult(data)

          const cleanPhoneSet = new Set(data.clean.map((c: CleanContact) => c.phone))
          const cleanContactList = parsedContacts.filter(c =>
            cleanPhoneSet.has(c.phone.replace('+1', '').replace('+', ''))
          )
          setCleanContacts(cleanContactList)
          setScrubProgress('')
        } else if (data.status === 'failed') {
          clearInterval(pollInterval)
          throw new Error(data.error || 'Validation failed')
        }
      } catch (err) {
        clearInterval(pollInterval)
        setError((err as Error).message)
        setScrubProgress('')
      }
    }, 3000)

    return () => clearInterval(pollInterval)
  }, [scrubKey, step, parsedContacts])

  // Start scrub when user clicks scrub button
  useEffect(() => {
    // Don't re-run if there's an error - let user see it and choose to retry
    if (step === 'scrub' && scrubStarted && !scrubResult && !scrubKey && !loading && !error) {
      startScrub()
    }
  }, [step, scrubStarted, scrubResult, scrubKey, loading, error])

  // Launch campaign (after scrub is complete)
  const launchCampaign = async () => {
    setLoading(true)
    setError(null)
    setStep('launching')

    let scheduledAt: string | undefined
    if (scheduleEnabled && scheduledDate && scheduledTime) {
      const scheduled = new Date(`${scheduledDate}T${scheduledTime}`)
      scheduledAt = scheduled.toISOString()
    }

    try {
      const csvData = buildCSV(cleanContacts)

      const res = await fetch('/api/campaign/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          csvData,
          message: isABTest ? undefined : message,
          messageA: isABTest ? messageA : undefined,
          messageB: isABTest ? messageB : undefined,
          dryRun: false,
          skipDedup,
          scheduledAt,
          followUp: followUpEnabled ? {
            delayDays: followUpDays,
            message: followUpMessage,
          } : undefined,
        }),
      })

      const data = await res.json()

      if (!res.ok) {
        throw new Error(data.error || 'Failed to launch campaign')
      }

      router.push(`/campaigns/${data.campaignId}`)
    } catch (err) {
      setError((err as Error).message)
      setStep('scrub')
    } finally {
      setLoading(false)
    }
  }

  // Preview a message with sample data
  const previewMessageText = (template: string) => {
    return template
      .replace(/\{firstName\}/g, 'John')
      .replace(/\{lastName\}/g, 'Smith')
      .replace(/\{city\}/g, 'Boston')
      .replace(/\{neighborhood\}/g, 'Beacon Hill')
  }

  return (
    <div className="max-w-3xl mx-auto">
      <Link href="/campaigns" className="text-blue-700 hover:text-blue-800 mb-4 inline-block font-medium">
        ← Back to Campaigns
      </Link>

      <h1 className="text-3xl font-bold text-gray-900 mb-8">New Campaign</h1>

      {error && (
        <div className="bg-red-50 border border-red-300 rounded-lg p-4 mb-6">
          <p className="text-red-700 font-medium">{error}</p>
        </div>
      )}

      {/* Progress Steps - NEW ORDER */}
      <div className="flex items-center gap-2 mb-6 text-sm font-medium">
        <span className={step === 'upload' ? 'text-blue-700' : 'text-gray-500'}>1. Upload</span>
        <span className="text-gray-400">→</span>
        <span className={step === 'message' ? 'text-blue-700' : 'text-gray-500'}>2. Message</span>
        <span className="text-gray-400">→</span>
        <span className={step === 'preview' ? 'text-blue-700' : 'text-gray-500'}>3. Preview</span>
        <span className="text-gray-400">→</span>
        <span className={step === 'scrub' || step === 'launching' ? 'text-blue-700' : 'text-gray-500'}>4. Scrub & Launch</span>
      </div>

      {/* Step 1: Upload CSV */}
      {step === 'upload' && (
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
          <h2 className="text-xl font-semibold text-gray-900 mb-4">Upload Contact List</h2>

          <div className="mb-6">
            <label className="block text-sm font-semibold text-gray-800 mb-2">
              Campaign Name
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g., 2025-01-15-Braintree"
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 placeholder:text-gray-400"
            />
          </div>

          <div className="mb-6">
            <label className="block text-sm font-semibold text-gray-800 mb-2">
              Property Radar CSV Export
            </label>
            <div className="border-2 border-dashed border-gray-300 rounded-lg p-8 text-center hover:border-gray-400 transition-colors">
              {csvFileName ? (
                <div>
                  <p className="text-base text-gray-900 font-semibold">{csvFileName}</p>
                  <p className="text-sm text-gray-600 mt-1">
                    {parsedContacts.length} phone numbers extracted
                  </p>
                  <button
                    onClick={() => {
                      setCsvFileName('')
                      setParsedContacts([])
                    }}
                    className="text-sm text-red-600 hover:text-red-700 mt-2 font-medium"
                  >
                    Remove
                  </button>
                </div>
              ) : (
                <div>
                  <input
                    type="file"
                    accept=".csv"
                    onChange={handleFileUpload}
                    className="hidden"
                    id="csv-upload"
                  />
                  <label
                    htmlFor="csv-upload"
                    className="cursor-pointer text-blue-700 hover:text-blue-800 font-medium"
                  >
                    Click to upload CSV
                  </label>
                  <p className="text-sm text-gray-600 mt-1">
                    Property Radar export format
                  </p>
                </div>
              )}
            </div>
          </div>

          {/* Draft save indicator */}
          {draftSavedAt && (
            <p className="text-sm text-green-600 mb-4">
              Draft saved at {draftSavedAt}
            </p>
          )}

          <div className="flex gap-3">
            <button
              onClick={saveDraft}
              disabled={savingDraft || !name}
              className="px-4 py-3 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 font-medium disabled:opacity-50 transition-colors"
            >
              {savingDraft ? 'Saving...' : 'Save Draft'}
            </button>
            <button
              onClick={() => setStep('message')}
              disabled={!name || parsedContacts.length === 0}
              className="flex-1 bg-blue-600 text-white px-4 py-3 rounded-lg hover:bg-blue-700 font-semibold disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              Continue to Message
            </button>
          </div>
        </div>
      )}

      {/* Step 2: Compose Message */}
      {step === 'message' && (
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
          <h2 className="text-xl font-semibold text-gray-900 mb-4">Compose Message</h2>

          <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 mb-6">
            <p className="text-sm text-blue-800 font-medium">
              {parsedContacts.length} contacts loaded from CSV
            </p>
          </div>

          <div className="mb-4">
            <label className="flex items-center cursor-pointer">
              <input
                type="checkbox"
                checked={isABTest}
                onChange={(e) => setIsABTest(e.target.checked)}
                className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
              />
              <span className="ml-2 text-sm font-medium text-gray-800">Enable A/B Testing</span>
            </label>
          </div>

          {!isABTest ? (
            <div className="mb-6">
              <label className="block text-sm font-semibold text-gray-800 mb-2">
                Message Template
              </label>
              <textarea
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                rows={4}
                placeholder="Hi {firstName}, I noticed you're a homeowner in {city}..."
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 placeholder:text-gray-400"
              />
              <div className="flex justify-between mt-2">
                <p className="text-sm text-gray-600">
                  Variables: {'{firstName}'}, {'{lastName}'}, {'{city}'}, {'{neighborhood}'}
                </p>
                <CharacterCounter length={message.length} />
              </div>
              {message && (
                <div className="mt-4 bg-gray-100 rounded-lg p-4 border border-gray-200">
                  <p className="text-xs font-semibold text-gray-600 uppercase mb-2">Preview</p>
                  <p className="text-sm text-gray-800">{previewMessageText(message)}</p>
                </div>
              )}
            </div>
          ) : (
            <div className="space-y-6 mb-6">
              <div>
                <label className="block text-sm font-semibold text-gray-800 mb-2">
                  Variant A (50%)
                </label>
                <textarea
                  value={messageA}
                  onChange={(e) => setMessageA(e.target.value)}
                  rows={3}
                  placeholder="Hi {firstName}, I noticed you're a homeowner in {city}..."
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 placeholder:text-gray-400"
                />
                <CharacterCounter length={messageA.length} />
              </div>
              <div>
                <label className="block text-sm font-semibold text-gray-800 mb-2">
                  Variant B (50%)
                </label>
                <textarea
                  value={messageB}
                  onChange={(e) => setMessageB(e.target.value)}
                  rows={3}
                  placeholder="Hey {firstName}! Noticed you're in {city}..."
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 placeholder:text-gray-400"
                />
                <CharacterCounter length={messageB.length} />
              </div>
            </div>
          )}

          <div className="mt-6 pt-4 border-t border-gray-200">
            <label className="flex items-center cursor-pointer">
              <input
                type="checkbox"
                checked={skipDedup}
                onChange={(e) => setSkipDedup(e.target.checked)}
                className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
              />
              <span className="ml-2 text-sm text-gray-700">
                Skip deduplication (send to contacts with existing conversations)
              </span>
            </label>
          </div>

          {/* Follow-up Message */}
          <div className="mt-6 pt-4 border-t border-gray-200">
            <label className="flex items-center cursor-pointer mb-3">
              <input
                type="checkbox"
                checked={followUpEnabled}
                onChange={(e) => setFollowUpEnabled(e.target.checked)}
                className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
              />
              <span className="ml-2 text-sm font-semibold text-gray-800">
                Enable follow-up message for non-responders
              </span>
            </label>

            {followUpEnabled && (
              <div className="space-y-4 pl-6 mt-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Send follow-up after
                  </label>
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      min="1"
                      max="30"
                      value={followUpDays}
                      onChange={(e) => setFollowUpDays(parseInt(e.target.value) || 3)}
                      className="w-20 px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                    />
                    <span className="text-sm text-gray-700">days with no response</span>
                  </div>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Follow-up Message
                  </label>
                  <textarea
                    value={followUpMessage}
                    onChange={(e) => setFollowUpMessage(e.target.value)}
                    rows={3}
                    placeholder="Hi {firstName}, just following up on my message from a few days ago..."
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 placeholder:text-gray-400"
                  />
                  <div className="flex justify-between mt-1">
                    <p className="text-sm text-gray-600">
                      Same variables: {'{firstName}'}, {'{city}'}, etc.
                    </p>
                    <CharacterCounter length={followUpMessage.length} />
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Draft save indicator */}
          {draftSavedAt && (
            <p className="text-sm text-green-600 mt-4">
              Draft saved at {draftSavedAt}
            </p>
          )}

          <div className="flex gap-3 mt-6">
            <button
              onClick={() => setStep('upload')}
              className="px-4 py-2 text-gray-700 hover:text-gray-900 font-medium"
            >
              Back
            </button>
            <button
              onClick={saveDraft}
              disabled={savingDraft}
              className="px-4 py-3 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 font-medium disabled:opacity-50 transition-colors"
            >
              {savingDraft ? 'Saving...' : 'Save Draft'}
            </button>
            <button
              onClick={runPreview}
              disabled={loading || (!message && (!messageA || !messageB))}
              className="flex-1 bg-blue-600 text-white px-4 py-3 rounded-lg hover:bg-blue-700 font-semibold disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {loading ? 'Processing...' : 'Preview Campaign'}
            </button>
          </div>
        </div>
      )}

      {/* Step 3: Preview & Schedule */}
      {step === 'preview' && previewResult && (
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
          <h2 className="text-xl font-semibold text-gray-900 mb-4">Preview & Schedule</h2>

          {/* Stats Summary */}
          <div className="grid grid-cols-2 md:grid-cols-3 gap-4 mb-6">
            <div className="bg-blue-50 rounded-lg p-4 border border-blue-200">
              <p className="text-xs font-semibold text-blue-700 uppercase">Total Contacts</p>
              <p className="text-2xl font-bold text-blue-800">{previewResult.processed}</p>
            </div>
            {previewResult.isMultiDay ? (
              <div className="bg-indigo-50 rounded-lg p-4 border border-indigo-200">
                <p className="text-xs font-semibold text-indigo-700 uppercase">Est. Campaign Duration</p>
                <p className="text-2xl font-bold text-indigo-800">~{previewResult.estimatedTotalDays} days</p>
              </div>
            ) : (
              <div className="bg-gray-100 rounded-lg p-4 border border-gray-200">
                <p className="text-xs font-semibold text-gray-600 uppercase">Est. Send Time</p>
                <p className="text-2xl font-bold text-gray-800">~{previewResult.estimatedMinutes} min</p>
              </div>
            )}
            {previewResult.skipped > 0 && (
              <div className="bg-amber-50 rounded-lg p-4 border border-amber-200">
                <p className="text-xs font-semibold text-amber-700 uppercase">Dedup Skipped</p>
                <p className="text-2xl font-bold text-amber-800">{previewResult.skipped}</p>
              </div>
            )}
          </div>

          {/* Multi-Day Campaign Info */}
          {previewResult.isMultiDay && (
            <div className="bg-indigo-50 rounded-lg p-4 mb-6 border border-indigo-200">
              <p className="text-sm font-semibold text-indigo-800 mb-2">Multi-Day Campaign</p>
              <div className="text-sm text-indigo-700 space-y-1">
                <p>This campaign will send <strong>{previewResult.dailyLimit}</strong> messages per day over <strong>~{previewResult.estimatedTotalDays} days</strong>.</p>
                <p>Day 1: {previewResult.batchSize} contacts will be sent today.</p>
                <p>Remaining: {previewResult.remainingContacts?.toLocaleString()} contacts queued for subsequent days.</p>
              </div>
            </div>
          )}

          {/* A/B Test Split */}
          {isABTest && (
            <div className="bg-purple-50 rounded-lg p-4 mb-6 border border-purple-200">
              <p className="text-sm font-semibold text-purple-800 mb-2">A/B Test Split</p>
              <div className="flex gap-4">
                {previewResult.isMultiDay ? (
                  <>
                    <span className="text-sm text-purple-700">
                      Variant A: ~{Math.round(previewResult.processed / 2).toLocaleString()} contacts (50%)
                    </span>
                    <span className="text-sm text-purple-700">
                      Variant B: ~{Math.round(previewResult.processed / 2).toLocaleString()} contacts (50%)
                    </span>
                  </>
                ) : (
                  <>
                    <span className="text-sm text-purple-700">
                      Variant A: {previewResult.variantCounts.A} contacts
                    </span>
                    <span className="text-sm text-purple-700">
                      Variant B: {previewResult.variantCounts.B} contacts
                    </span>
                  </>
                )}
              </div>
              {previewResult.isMultiDay && (
                <p className="text-xs text-purple-600 mt-2">
                  Contacts are randomly assigned to variants at send time each day.
                </p>
              )}
            </div>
          )}

          {/* Follow-up info */}
          {followUpEnabled && (
            <div className="bg-green-50 rounded-lg p-4 mb-6 border border-green-200">
              <p className="text-sm font-semibold text-green-800">Follow-up Enabled</p>
              <p className="text-sm text-green-700 mt-1">
                Non-responders will receive a follow-up after {followUpDays} days
              </p>
            </div>
          )}

          {/* Message Preview */}
          <div className="mb-6">
            <h3 className="text-sm font-semibold text-gray-800 mb-3">Sample Messages</h3>
            <div className="space-y-2">
              {previewResult.preview.slice(0, 5).map((contact, i) => (
                <div key={i} className="bg-gray-100 rounded-lg p-4 border border-gray-200">
                  <div className="flex justify-between text-xs text-gray-600 mb-2">
                    <span className="font-medium">{contact.name} • {contact.city}</span>
                    {contact.variant && (
                      <span className="text-purple-700 font-medium">Variant {contact.variant}</span>
                    )}
                  </div>
                  <p className="text-sm text-gray-800 whitespace-pre-wrap">{contact.message}</p>
                </div>
              ))}
            </div>
          </div>

          {/* Scheduling */}
          <div className="mb-6 p-4 bg-gray-100 rounded-lg border border-gray-200">
            <label className="flex items-center cursor-pointer mb-3">
              <input
                type="checkbox"
                checked={scheduleEnabled}
                onChange={(e) => setScheduleEnabled(e.target.checked)}
                className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
              />
              <span className="ml-2 text-sm font-semibold text-gray-800">Schedule for later</span>
            </label>

            {scheduleEnabled && (
              <div className="flex gap-3 mt-3">
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Date</label>
                  <input
                    type="date"
                    value={scheduledDate}
                    onChange={(e) => setScheduledDate(e.target.value)}
                    min={new Date().toISOString().split('T')[0]}
                    className="px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Time</label>
                  <input
                    type="time"
                    value={scheduledTime}
                    onChange={(e) => setScheduledTime(e.target.value)}
                    className="px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-sm"
                  />
                </div>
              </div>
            )}
          </div>

          {/* Dev Mode Toggle */}
          <div className="mb-6 p-4 bg-yellow-50 rounded-lg border border-yellow-300">
            <label className="flex items-center cursor-pointer">
              <input
                type="checkbox"
                checked={devModeSkipScrub}
                onChange={(e) => setDevModeSkipScrub(e.target.checked)}
                className="rounded border-yellow-400 text-yellow-600 focus:ring-yellow-500"
              />
              <span className="ml-2 text-sm font-semibold text-yellow-800">
                DEV MODE: Skip phone scrubbing (for testing only)
              </span>
            </label>
            <p className="text-xs text-yellow-700 mt-1 ml-6">
              Bypasses SearchBug API - all phones pass through as clean
            </p>
          </div>

          {/* Draft save indicator */}
          {draftSavedAt && (
            <p className="text-sm text-green-600 mb-4">
              Draft saved at {draftSavedAt}
            </p>
          )}

          <div className="flex gap-3">
            <button
              onClick={() => setStep('message')}
              className="px-4 py-2 text-gray-700 hover:text-gray-900 font-medium"
            >
              Back
            </button>
            <button
              onClick={saveDraft}
              disabled={savingDraft}
              className="px-4 py-3 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 font-medium disabled:opacity-50 transition-colors"
            >
              {savingDraft ? 'Saving...' : 'Save Draft'}
            </button>
            <button
              onClick={() => {
                setScrubResult(null)
                setScrubKey(null)
                setPreFilterStats(null)
                setScrubStarted(false)
                setStep('scrub')
              }}
              disabled={scheduleEnabled && (!scheduledDate || !scheduledTime)}
              className="flex-1 bg-green-600 text-white px-4 py-3 rounded-lg hover:bg-green-700 font-semibold disabled:opacity-50 transition-colors"
            >
              Continue to Scrub & Launch
            </button>
          </div>
        </div>
      )}

      {/* Step 4: Scrub & Launch */}
      {step === 'scrub' && (
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
          <h2 className="text-xl font-semibold text-gray-900 mb-4">Scrub & Launch</h2>

          {/* Pre-scrub state: show preview stats with warning */}
          {!scrubStarted && !scrubResult && previewResult && (
            <div>
              {/* Warning Banner */}
              <div className="bg-amber-50 border border-amber-300 rounded-lg p-4 mb-6">
                <div className="flex items-start gap-3">
                  <span className="text-amber-600 text-xl">&#9888;</span>
                  <div>
                    <p className="font-semibold text-amber-800">Not Yet Scrubbed</p>
                    <p className="text-sm text-amber-700 mt-1">
                      These numbers are estimates. Scrubbing will remove DNC numbers, litigators, and landlines which may significantly reduce the final count.
                    </p>
                  </div>
                </div>
              </div>

              {/* Pre-scrub Stats */}
              <div className="grid grid-cols-2 md:grid-cols-3 gap-4 mb-6">
                <div className="bg-blue-50 rounded-lg p-4 border border-blue-200">
                  <p className="text-xs font-semibold text-blue-700 uppercase">Total Contacts</p>
                  <p className="text-2xl font-bold text-blue-800">{previewResult.processed}</p>
                  <p className="text-xs text-blue-600">Before scrubbing</p>
                </div>
                {previewResult.isMultiDay ? (
                  <div className="bg-indigo-50 rounded-lg p-4 border border-indigo-200">
                    <p className="text-xs font-semibold text-indigo-700 uppercase">Est. Duration</p>
                    <p className="text-2xl font-bold text-indigo-800">~{previewResult.estimatedTotalDays} days</p>
                    <p className="text-xs text-indigo-600">May change after scrub</p>
                  </div>
                ) : (
                  <div className="bg-gray-100 rounded-lg p-4 border border-gray-200">
                    <p className="text-xs font-semibold text-gray-600 uppercase">Est. Send Time</p>
                    <p className="text-2xl font-bold text-gray-800">~{previewResult.estimatedMinutes} min</p>
                  </div>
                )}
                <div className="bg-amber-50 rounded-lg p-4 border border-amber-200">
                  <p className="text-xs font-semibold text-amber-700 uppercase">Daily Limit</p>
                  <p className="text-2xl font-bold text-amber-800">{previewResult.dailyLimit || 125}</p>
                  <p className="text-xs text-amber-600">messages/day</p>
                </div>
              </div>

              {/* Multi-day info */}
              {previewResult.isMultiDay && (
                <div className="bg-indigo-50 rounded-lg p-4 mb-6 border border-indigo-200">
                  <p className="text-sm font-semibold text-indigo-800 mb-1">Multi-Day Campaign</p>
                  <p className="text-sm text-indigo-700">
                    {previewResult.processed.toLocaleString()} contacts will be sent over ~{previewResult.estimatedTotalDays} days at {previewResult.dailyLimit}/day.
                  </p>
                </div>
              )}

              {/* A/B Test info */}
              {isABTest && (
                <div className="bg-purple-50 rounded-lg p-4 mb-6 border border-purple-200">
                  <p className="text-sm font-semibold text-purple-800">A/B Test: 50/50 Split</p>
                  <p className="text-sm text-purple-700">
                    ~{Math.round(previewResult.processed / 2).toLocaleString()} contacts per variant
                  </p>
                </div>
              )}

              {/* Draft save indicator */}
              {draftSavedAt && (
                <p className="text-sm text-green-600 mb-4">
                  Draft saved at {draftSavedAt}
                </p>
              )}

              <div className="flex gap-3">
                <button
                  onClick={() => setStep('preview')}
                  className="px-4 py-2 text-gray-700 hover:text-gray-900 font-medium"
                >
                  Back
                </button>
                <button
                  onClick={saveDraft}
                  disabled={savingDraft}
                  className="px-4 py-3 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 font-medium disabled:opacity-50 transition-colors"
                >
                  {savingDraft ? 'Saving...' : 'Save Draft'}
                </button>
                <button
                  onClick={() => {
                    if (devModeSkipScrub) {
                      // Skip scrub - use all contacts as clean
                      setCleanContacts(parsedContacts)
                      setScrubResult({
                        status: 'complete',
                        summary: {
                          total: parsedContacts.length,
                          clean: parsedContacts.length,
                          dnc: 0,
                          litigator: 0,
                          landline: 0,
                          inactive: 0,
                        },
                        clean: parsedContacts.map(c => ({
                          id: c.id,
                          phone: c.phone,
                          carrier: 'unknown',
                          type: 'mobile',
                          state: 'unknown',
                        })),
                        removed: { dnc: [], litigator: [], landline: [], inactive: [] },
                      })
                    } else {
                      setScrubStarted(true)
                    }
                  }}
                  className="flex-1 bg-blue-600 text-white px-4 py-3 rounded-lg hover:bg-blue-700 font-semibold transition-colors"
                >
                  {devModeSkipScrub ? 'Skip Scrub (Dev Mode)' : `Scrub ${previewResult.processed.toLocaleString()} Contacts`}
                </button>
              </div>
            </div>
          )}

          {/* Scrubbing in progress */}
          {scrubStarted && !scrubResult && !error && (
            <div className="text-center py-8">
              <div className="animate-spin w-12 h-12 border-4 border-blue-600 border-t-transparent rounded-full mx-auto mb-4" />
              <p className="text-gray-700 font-medium">{scrubProgress || 'Starting validation...'}</p>
              <p className="text-sm text-gray-600 mt-2">
                Checking DNC lists, litigators, and line types...
              </p>
            </div>
          )}

          {/* Error state */}
          {scrubStarted && !scrubResult && error && (
            <div className="py-6">
              <div className="bg-red-50 border border-red-300 rounded-lg p-4 mb-6">
                <div className="flex items-start gap-3">
                  <span className="text-red-600 text-xl">&#10006;</span>
                  <div>
                    <p className="font-semibold text-red-800">Scrub Failed</p>
                    <p className="text-sm text-red-700 mt-1">{error}</p>
                  </div>
                </div>
              </div>

              <div className="flex gap-3">
                <button
                  onClick={() => {
                    setScrubStarted(false)
                    setError(null)
                    setPreFilteredPhones(null) // Clear cache when going back
                    setPreFilterStats(null)
                    setStep('preview')
                  }}
                  className="px-4 py-2 text-gray-700 hover:text-gray-900 font-medium"
                >
                  Back
                </button>
                <button
                  onClick={() => {
                    setError(null)
                    setScrubStarted(false)
                    setScrubKey(null)
                    // Re-trigger scrub - preFilteredPhones are preserved so OpenPhone won't re-run
                    setTimeout(() => setScrubStarted(true), 100)
                  }}
                  className="px-4 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 font-medium"
                >
                  {preFilteredPhones ? 'Retry SearchBug Only' : 'Retry Scrub'}
                </button>
              </div>
            </div>
          )}

          {/* Scrub complete - show results */}
          {scrubResult && (
            <div>
              {/* Summary Cards */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
                <div className="bg-green-50 rounded-lg p-4 border border-green-300">
                  <p className="text-xs font-semibold text-green-700 uppercase">Clean</p>
                  <p className="text-2xl font-bold text-green-800">{scrubResult.summary.clean}</p>
                  <p className="text-xs text-green-700">Ready to send</p>
                </div>
                <div className="bg-gray-100 rounded-lg p-4 border border-gray-200">
                  <p className="text-xs font-semibold text-gray-600 uppercase">Original</p>
                  <p className="text-2xl font-bold text-gray-800">
                    {preFilterStats?.original || parsedContacts.length}
                  </p>
                </div>
                {preFilterStats && Object.values(preFilterStats.removed).reduce((a, b) => a + b, 0) > 0 && (
                  <div className="bg-blue-50 rounded-lg p-4 border border-blue-200">
                    <p className="text-xs font-semibold text-blue-700 uppercase">Pre-filtered</p>
                    <p className="text-2xl font-bold text-blue-800">
                      {Object.values(preFilterStats.removed).reduce((a, b) => a + b, 0)}
                    </p>
                    <p className="text-xs text-blue-700">Free (internal)</p>
                  </div>
                )}
                <div className="bg-red-50 rounded-lg p-4 border border-red-200">
                  <p className="text-xs font-semibold text-red-700 uppercase">Removed</p>
                  <p className="text-2xl font-bold text-red-800">
                    {scrubResult.summary.total - scrubResult.summary.clean}
                  </p>
                </div>
              </div>

              {/* Removal Breakdown */}
              {(scrubResult.summary.total > scrubResult.summary.clean || (preFilterStats && Object.values(preFilterStats.removed).reduce((a, b) => a + b, 0) > 0)) && (
                <div className="bg-gray-100 rounded-lg p-4 mb-6 border border-gray-200">
                  <h3 className="text-sm font-semibold text-gray-800 mb-3">Removal Breakdown</h3>
                  <div className="space-y-2">
                    {preFilterStats && (
                      <>
                        {preFilterStats.removed.optout > 0 && (
                          <div className="flex justify-between text-sm">
                            <span className="text-gray-700">Opt-outs (replied STOP)</span>
                            <span className="font-semibold text-red-700">{preFilterStats.removed.optout}</span>
                          </div>
                        )}
                        {preFilterStats.removed.previousCampaign > 0 && (
                          <div className="flex justify-between text-sm">
                            <span className="text-gray-700">Already messaged (previous campaign)</span>
                            <span className="font-semibold text-blue-700">{preFilterStats.removed.previousCampaign}</span>
                          </div>
                        )}
                        {preFilterStats.removed.openphoneHistory > 0 && (
                          <div className="flex justify-between text-sm">
                            <span className="text-gray-700">Existing conversation (OpenPhone)</span>
                            <span className="font-semibold text-blue-700">{preFilterStats.removed.openphoneHistory}</span>
                          </div>
                        )}
                        {preFilterStats.removed.dnc > 0 && (
                          <div className="flex justify-between text-sm">
                            <span className="text-gray-700">DNC (from previous scrubs)</span>
                            <span className="font-semibold text-red-700">{preFilterStats.removed.dnc}</span>
                          </div>
                        )}
                        {preFilterStats.removed.litigator > 0 && (
                          <div className="flex justify-between text-sm">
                            <span className="text-gray-700">Litigators (from previous scrubs)</span>
                            <span className="font-semibold text-red-700">{preFilterStats.removed.litigator}</span>
                          </div>
                        )}
                      </>
                    )}
                    {scrubResult.summary.dnc > 0 && (
                      <div className="flex justify-between text-sm">
                        <span className="text-gray-700">Do Not Call (DNC)</span>
                        <span className="font-semibold text-red-700">{scrubResult.summary.dnc}</span>
                      </div>
                    )}
                    {scrubResult.summary.litigator > 0 && (
                      <div className="flex justify-between text-sm">
                        <span className="text-gray-700">TCPA Litigators</span>
                        <span className="font-semibold text-red-700">{scrubResult.summary.litigator}</span>
                      </div>
                    )}
                    {scrubResult.summary.landline > 0 && (
                      <div className="flex justify-between text-sm">
                        <span className="text-gray-700">Landlines (can&apos;t SMS)</span>
                        <span className="font-semibold text-orange-700">{scrubResult.summary.landline}</span>
                      </div>
                    )}
                    {scrubResult.summary.inactive > 0 && (
                      <div className="flex justify-between text-sm">
                        <span className="text-gray-700">Inactive/Invalid</span>
                        <span className="font-semibold text-gray-700">{scrubResult.summary.inactive}</span>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Draft save indicator */}
              {draftSavedAt && (
                <p className="text-sm text-green-600 mb-4">
                  Draft saved at {draftSavedAt}
                </p>
              )}

              {/* Updated stats after scrub */}
              {previewResult?.isMultiDay && (
                <div className="bg-indigo-50 rounded-lg p-4 mb-6 border border-indigo-200">
                  <p className="text-sm font-semibold text-indigo-800 mb-1">Updated Multi-Day Estimate</p>
                  <p className="text-sm text-indigo-700">
                    {cleanContacts.length.toLocaleString()} clean contacts will be sent over ~{Math.ceil(cleanContacts.length / (previewResult.dailyLimit || 125))} days at {previewResult.dailyLimit || 125}/day.
                  </p>
                </div>
              )}

              <div className="flex gap-3">
                <button
                  onClick={() => {
                    setScrubResult(null)
                    setScrubKey(null)
                    setPreFilterStats(null)
                    setScrubStarted(false)
                    setStep('preview')
                  }}
                  className="px-4 py-2 text-gray-700 hover:text-gray-900 font-medium"
                >
                  Back
                </button>
                <button
                  onClick={saveDraft}
                  disabled={savingDraft}
                  className="px-4 py-3 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 font-medium disabled:opacity-50 transition-colors"
                >
                  {savingDraft ? 'Saving...' : 'Save Draft'}
                </button>
                <button
                  onClick={launchCampaign}
                  disabled={loading || cleanContacts.length === 0}
                  className="flex-1 bg-green-600 text-white px-4 py-3 rounded-lg hover:bg-green-700 font-semibold disabled:opacity-50 transition-colors"
                >
                  {loading ? 'Launching...' : scheduleEnabled
                    ? `Schedule Campaign (${cleanContacts.length} messages)`
                    : `Launch Campaign (${cleanContacts.length} messages)`}
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Launching State */}
      {step === 'launching' && (
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-8 text-center">
          <div className="animate-spin w-12 h-12 border-4 border-green-600 border-t-transparent rounded-full mx-auto mb-4" />
          <h2 className="text-xl font-semibold text-gray-900">Launching Campaign...</h2>
          <p className="text-gray-600 mt-2">Creating contacts and queuing messages</p>
        </div>
      )}
    </div>
  )
}

// Wrap in Suspense for useSearchParams
export default function NewCampaignPage() {
  return (
    <Suspense fallback={
      <div className="max-w-3xl mx-auto">
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-8 text-center">
          <div className="animate-spin w-8 h-8 border-4 border-blue-600 border-t-transparent rounded-full mx-auto" />
          <p className="text-gray-600 mt-4">Loading...</p>
        </div>
      </div>
    }>
      <NewCampaignPageContent />
    </Suspense>
  )
}
