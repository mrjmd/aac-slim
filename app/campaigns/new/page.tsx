'use client'

import { useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'

interface ParseStats {
  totalRows: number
  primaryContacts: number
  secondaryContacts: number
  skippedNoPhone: number
  skippedInactivePhone: number
  skippedInvalidPhone: number
}

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
  parseStats: ParseStats
  processed: number
  queued: number
  skipped: number
  pipedriveCreated: number
  variantCounts: Record<string, number>
  preview: PreviewContact[]
  estimatedMinutes: number
}

export default function NewCampaignPage() {
  const router = useRouter()

  // Form state
  const [step, setStep] = useState<'upload' | 'message' | 'preview' | 'sending'>('upload')
  const [name, setName] = useState('')
  const [csvData, setCsvData] = useState('')
  const [csvFileName, setCsvFileName] = useState('')
  const [message, setMessage] = useState('')
  const [isABTest, setIsABTest] = useState(false)
  const [messageA, setMessageA] = useState('')
  const [messageB, setMessageB] = useState('')
  const [skipDedup, setSkipDedup] = useState(false)

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
      setCsvData(content)

      // Auto-generate campaign name from filename
      if (!name) {
        const baseName = file.name.replace(/\.csv$/i, '')
        const date = new Date().toISOString().split('T')[0]
        setName(`${date}-${baseName}`)
      }
    }
    reader.readAsText(file)
  }, [name])

  const runDryRun = async () => {
    setLoading(true)
    setError(null)

    try {
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
        }),
      })

      const data = await res.json()

      if (!res.ok) {
        throw new Error(data.error || 'Failed to process campaign')
      }

      setPreviewResult(data)
      setStep('preview')
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }

  const launchCampaign = async () => {
    setLoading(true)
    setError(null)
    setStep('sending')

    try {
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
        }),
      })

      const data = await res.json()

      if (!res.ok) {
        throw new Error(data.error || 'Failed to launch campaign')
      }

      // Redirect to campaign detail page
      router.push(`/campaigns/${data.campaignId}`)
    } catch (err) {
      setError((err as Error).message)
      setStep('preview')
    } finally {
      setLoading(false)
    }
  }

  // Preview a message with sample data
  const previewMessage = (template: string) => {
    return template
      .replace(/\{firstName\}/g, 'John')
      .replace(/\{lastName\}/g, 'Smith')
      .replace(/\{city\}/g, 'Boston')
      .replace(/\{neighborhood\}/g, 'Beacon Hill')
  }

  return (
    <div className="max-w-3xl mx-auto">
      <Link href="/campaigns" className="text-blue-600 hover:text-blue-700 mb-4 inline-block">
        ← Back to Campaigns
      </Link>

      <h1 className="text-3xl font-bold text-gray-900 mb-8">New Campaign</h1>

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 mb-6">
          <p className="text-red-600">{error}</p>
        </div>
      )}

      {/* Step 1: Upload CSV */}
      {step === 'upload' && (
        <div className="bg-white rounded-lg shadow p-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">1. Upload Contact List</h2>

          <div className="mb-6">
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Campaign Name
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g., 2025-01-15-Braintree"
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-blue-500 focus:border-blue-500"
            />
          </div>

          <div className="mb-6">
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Property Radar CSV Export
            </label>
            <div className="border-2 border-dashed border-gray-300 rounded-lg p-8 text-center">
              {csvFileName ? (
                <div>
                  <p className="text-sm text-gray-900 font-medium">{csvFileName}</p>
                  <p className="text-xs text-gray-500 mt-1">
                    {csvData.split('\n').length - 1} rows
                  </p>
                  <button
                    onClick={() => {
                      setCsvData('')
                      setCsvFileName('')
                    }}
                    className="text-sm text-blue-600 hover:text-blue-700 mt-2"
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
                    className="cursor-pointer text-blue-600 hover:text-blue-700"
                  >
                    Click to upload CSV
                  </label>
                  <p className="text-xs text-gray-500 mt-1">
                    Property Radar export format
                  </p>
                </div>
              )}
            </div>
          </div>

          <button
            onClick={() => setStep('message')}
            disabled={!name || !csvData}
            className="w-full bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700 font-medium disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Continue
          </button>
        </div>
      )}

      {/* Step 2: Compose Message */}
      {step === 'message' && (
        <div className="bg-white rounded-lg shadow p-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">2. Compose Message</h2>

          <div className="mb-4">
            <label className="flex items-center">
              <input
                type="checkbox"
                checked={isABTest}
                onChange={(e) => setIsABTest(e.target.checked)}
                className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
              />
              <span className="ml-2 text-sm text-gray-700">Enable A/B Testing</span>
            </label>
          </div>

          {!isABTest ? (
            <div className="mb-6">
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Message Template
              </label>
              <textarea
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                rows={4}
                placeholder="Hi {firstName}, I noticed you're a homeowner in {city}..."
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-blue-500 focus:border-blue-500"
              />
              <div className="flex justify-between mt-2">
                <p className="text-xs text-gray-500">
                  Variables: {'{firstName}'}, {'{lastName}'}, {'{city}'}, {'{neighborhood}'}
                </p>
                <p className={`text-xs ${message.length > 160 ? 'text-red-500' : 'text-gray-500'}`}>
                  {message.length}/160
                </p>
              </div>
              {message && (
                <div className="mt-4 bg-gray-50 rounded-lg p-3">
                  <p className="text-xs text-gray-500 mb-1">Preview:</p>
                  <p className="text-sm text-gray-700">{previewMessage(message)}</p>
                </div>
              )}
            </div>
          ) : (
            <div className="space-y-6">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Variant A (50%)
                </label>
                <textarea
                  value={messageA}
                  onChange={(e) => setMessageA(e.target.value)}
                  rows={3}
                  placeholder="Hi {firstName}, I noticed you're a homeowner in {city}..."
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-blue-500 focus:border-blue-500"
                />
                <p className={`text-xs mt-1 ${messageA.length > 160 ? 'text-red-500' : 'text-gray-500'}`}>
                  {messageA.length}/160
                </p>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Variant B (50%)
                </label>
                <textarea
                  value={messageB}
                  onChange={(e) => setMessageB(e.target.value)}
                  rows={3}
                  placeholder="Hey {firstName}! Noticed you're in {city}..."
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-blue-500 focus:border-blue-500"
                />
                <p className={`text-xs mt-1 ${messageB.length > 160 ? 'text-red-500' : 'text-gray-500'}`}>
                  {messageB.length}/160
                </p>
              </div>
            </div>
          )}

          <div className="mt-6 pt-4 border-t border-gray-200">
            <label className="flex items-center">
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

          <div className="flex gap-3 mt-6">
            <button
              onClick={() => setStep('upload')}
              className="px-4 py-2 text-gray-700 hover:text-gray-900"
            >
              Back
            </button>
            <button
              onClick={runDryRun}
              disabled={loading || (!message && (!messageA || !messageB))}
              className="flex-1 bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700 font-medium disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {loading ? 'Processing...' : 'Preview Campaign'}
            </button>
          </div>
        </div>
      )}

      {/* Step 3: Preview & Launch */}
      {step === 'preview' && previewResult && (
        <div className="space-y-6">
          <div className="bg-white rounded-lg shadow p-6">
            <h2 className="text-lg font-semibold text-gray-900 mb-4">3. Review & Launch</h2>

            {/* Stats Summary */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
              <div className="bg-gray-50 rounded-lg p-3">
                <p className="text-xs text-gray-500">CSV Rows</p>
                <p className="text-lg font-semibold">{previewResult.parseStats.totalRows}</p>
              </div>
              <div className="bg-gray-50 rounded-lg p-3">
                <p className="text-xs text-gray-500">Valid Contacts</p>
                <p className="text-lg font-semibold">{previewResult.queued}</p>
              </div>
              <div className="bg-gray-50 rounded-lg p-3">
                <p className="text-xs text-gray-500">Skipped</p>
                <p className="text-lg font-semibold">{previewResult.parseStats.skippedNoPhone + previewResult.parseStats.skippedInactivePhone + previewResult.parseStats.skippedInvalidPhone}</p>
              </div>
              <div className="bg-gray-50 rounded-lg p-3">
                <p className="text-xs text-gray-500">Est. Time</p>
                <p className="text-lg font-semibold">~{previewResult.estimatedMinutes} min</p>
              </div>
            </div>

            {/* A/B Test Split */}
            {isABTest && (
              <div className="bg-purple-50 rounded-lg p-4 mb-6">
                <p className="text-sm font-medium text-purple-800 mb-2">A/B Test Split</p>
                <div className="flex gap-4">
                  <span className="text-sm text-purple-700">
                    Variant A: {previewResult.variantCounts.A} contacts
                  </span>
                  <span className="text-sm text-purple-700">
                    Variant B: {previewResult.variantCounts.B} contacts
                  </span>
                </div>
              </div>
            )}

            {/* Message Preview */}
            <div className="mb-6">
              <h3 className="text-sm font-medium text-gray-700 mb-2">Sample Messages</h3>
              <div className="space-y-2">
                {previewResult.preview.slice(0, 5).map((contact, i) => (
                  <div key={i} className="bg-gray-50 rounded-lg p-3 text-sm">
                    <div className="flex justify-between text-xs text-gray-500 mb-1">
                      <span>{contact.name} • {contact.city}</span>
                      {contact.variant && (
                        <span className="text-purple-600">Variant {contact.variant}</span>
                      )}
                    </div>
                    <p className="text-gray-700">{contact.message}</p>
                  </div>
                ))}
              </div>
            </div>

            <div className="flex gap-3">
              <button
                onClick={() => setStep('message')}
                className="px-4 py-2 text-gray-700 hover:text-gray-900"
              >
                Back
              </button>
              <button
                onClick={launchCampaign}
                disabled={loading}
                className="flex-1 bg-green-600 text-white px-4 py-2 rounded-lg hover:bg-green-700 font-medium disabled:opacity-50"
              >
                {loading ? 'Launching...' : `Launch Campaign (${previewResult.queued} messages)`}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Step 4: Sending */}
      {step === 'sending' && (
        <div className="bg-white rounded-lg shadow p-8 text-center">
          <div className="animate-spin w-12 h-12 border-4 border-blue-600 border-t-transparent rounded-full mx-auto mb-4" />
          <h2 className="text-lg font-semibold text-gray-900">Launching Campaign...</h2>
          <p className="text-gray-500 mt-2">Creating contacts and queuing messages</p>
        </div>
      )}
    </div>
  )
}
