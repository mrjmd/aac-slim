'use client'

import { useState, useEffect } from 'react'

interface HealthMetrics {
  webhooks: {
    pipedrive: { processed24h: number; lastProcessed: string | null }
    quo: { processed24h: number; lastProcessed: string | null }
    googleAds: { processed24h: number; lastProcessed: string | null }
  }
  sync: {
    pdToQuo: number
    pdToQb: number
    phoneToPd: number
  }
  campaigns: {
    active: number
    totalSent24h: number
    totalResponses24h: number
    optOuts24h: number
  }
  errors: Array<{
    timestamp: string
    source: string
    message: string
    details?: string
  }>
  qstash: {
    pending: number
    failed: number
  }
}

export default function HealthPage() {
  const [metrics, setMetrics] = useState<HealthMetrics | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [lastRefresh, setLastRefresh] = useState<Date>(new Date())

  useEffect(() => {
    fetchMetrics()
    const interval = setInterval(fetchMetrics, 30000) // Refresh every 30s
    return () => clearInterval(interval)
  }, [])

  async function fetchMetrics() {
    try {
      const res = await fetch('/api/health')
      if (!res.ok) throw new Error('Failed to fetch metrics')
      const data = await res.json()
      setMetrics(data)
      setLastRefresh(new Date())
      setError(null)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }

  function formatRelativeTime(dateString: string | null): string {
    if (!dateString) return 'Never'
    const date = new Date(dateString)
    const now = new Date()
    const diffMs = now.getTime() - date.getTime()
    const diffMins = Math.floor(diffMs / 60000)
    const diffHours = Math.floor(diffMs / 3600000)
    const diffDays = Math.floor(diffMs / 86400000)

    if (diffMins < 1) return 'Just now'
    if (diffMins < 60) return `${diffMins}m ago`
    if (diffHours < 24) return `${diffHours}h ago`
    return `${diffDays}d ago`
  }

  function getStatusColor(lastProcessed: string | null): string {
    if (!lastProcessed) return 'bg-gray-400'
    const diffMs = new Date().getTime() - new Date(lastProcessed).getTime()
    const diffHours = diffMs / 3600000
    if (diffHours < 1) return 'bg-green-500'
    if (diffHours < 6) return 'bg-yellow-500'
    return 'bg-red-500'
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin w-8 h-8 border-4 border-blue-600 border-t-transparent rounded-full" />
      </div>
    )
  }

  if (error) {
    return (
      <div className="bg-red-50 rounded-lg p-8 text-center text-red-600">
        {error}
        <button onClick={fetchMetrics} className="block mx-auto mt-4 text-blue-600 hover:text-blue-700">
          Retry
        </button>
      </div>
    )
  }

  return (
    <div>
      <div className="flex justify-between items-center mb-8">
        <h1 className="text-3xl font-bold text-gray-900">System Health</h1>
        <div className="text-sm text-gray-500">
          Last updated: {lastRefresh.toLocaleTimeString()}
          <button onClick={fetchMetrics} className="ml-3 text-blue-600 hover:text-blue-700">
            Refresh
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Webhook Stats */}
        <div className="bg-white rounded-lg shadow p-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">Webhook Processing (24h)</h2>
          <div className="space-y-4">
            <WebhookRow
              label="Pipedrive"
              count={metrics?.webhooks.pipedrive.processed24h || 0}
              lastProcessed={metrics?.webhooks.pipedrive.lastProcessed || null}
              formatTime={formatRelativeTime}
              statusColor={getStatusColor(metrics?.webhooks.pipedrive.lastProcessed || null)}
            />
            <WebhookRow
              label="Quo (OpenPhone)"
              count={metrics?.webhooks.quo.processed24h || 0}
              lastProcessed={metrics?.webhooks.quo.lastProcessed || null}
              formatTime={formatRelativeTime}
              statusColor={getStatusColor(metrics?.webhooks.quo.lastProcessed || null)}
            />
            <WebhookRow
              label="Google Ads"
              count={metrics?.webhooks.googleAds.processed24h || 0}
              lastProcessed={metrics?.webhooks.googleAds.lastProcessed || null}
              formatTime={formatRelativeTime}
              statusColor={getStatusColor(metrics?.webhooks.googleAds.lastProcessed || null)}
            />
          </div>
        </div>

        {/* Sync Coverage */}
        <div className="bg-white rounded-lg shadow p-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">Sync Coverage</h2>
          <div className="space-y-3">
            <MetricRow
              label="PD → Quo mappings"
              value={metrics?.sync.pdToQuo.toLocaleString() || '0'}
            />
            <MetricRow
              label="PD → QB mappings"
              value={metrics?.sync.pdToQb.toLocaleString() || '0'}
            />
            <MetricRow
              label="Phone → PD mappings"
              value={metrics?.sync.phoneToPd.toLocaleString() || '0'}
            />
          </div>
        </div>

        {/* Campaign Stats */}
        <div className="bg-white rounded-lg shadow p-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">Campaign Activity</h2>
          <div className="space-y-3">
            <MetricRow
              label="Active campaigns"
              value={metrics?.campaigns.active.toString() || '0'}
            />
            <MetricRow
              label="Messages sent (24h)"
              value={metrics?.campaigns.totalSent24h.toLocaleString() || '0'}
            />
            <MetricRow
              label="Responses (24h)"
              value={metrics?.campaigns.totalResponses24h.toLocaleString() || '0'}
              highlight="green"
            />
            <MetricRow
              label="Opt-outs (24h)"
              value={metrics?.campaigns.optOuts24h.toLocaleString() || '0'}
              highlight={metrics?.campaigns.optOuts24h && metrics.campaigns.optOuts24h > 0 ? 'red' : undefined}
            />
          </div>
        </div>

        {/* QStash Queue */}
        <div className="bg-white rounded-lg shadow p-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">QStash Queue</h2>
          <div className="space-y-3">
            <MetricRow
              label="Pending messages"
              value={metrics?.qstash.pending.toLocaleString() || '0'}
            />
            <MetricRow
              label="Failed (retry pending)"
              value={metrics?.qstash.failed.toLocaleString() || '0'}
              highlight={metrics?.qstash.failed && metrics.qstash.failed > 0 ? 'red' : undefined}
            />
          </div>
        </div>

        {/* Recent Errors */}
        <div className="bg-white rounded-lg shadow p-6 lg:col-span-2">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">Recent Errors</h2>
          {!metrics?.errors || metrics.errors.length === 0 ? (
            <div className="text-center py-8 text-gray-500">
              <span className="inline-block w-3 h-3 bg-green-500 rounded-full mr-2" />
              No errors in the last 24 hours
            </div>
          ) : (
            <div className="space-y-3">
              {metrics.errors.map((error, i) => (
                <div key={i} className="bg-red-50 rounded-lg p-3">
                  <div className="flex justify-between text-xs text-gray-500 mb-1">
                    <span className="font-medium text-red-700">{error.source}</span>
                    <span>{formatRelativeTime(error.timestamp)}</span>
                  </div>
                  <p className="text-sm text-red-800">{error.message}</p>
                  {error.details && (
                    <p className="text-xs text-red-600 mt-1 font-mono">{error.details}</p>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function WebhookRow({
  label,
  count,
  lastProcessed,
  formatTime,
  statusColor,
}: {
  label: string
  count: number
  lastProcessed: string | null
  formatTime: (date: string | null) => string
  statusColor: string
}) {
  return (
    <div className="flex items-center justify-between">
      <div className="flex items-center">
        <span className={`w-2 h-2 rounded-full ${statusColor} mr-3`} />
        <span className="text-sm text-gray-600">{label}</span>
      </div>
      <div className="text-right">
        <span className="text-sm font-medium text-gray-900">{count.toLocaleString()}</span>
        <span className="text-xs text-gray-500 ml-2">({formatTime(lastProcessed)})</span>
      </div>
    </div>
  )
}

function MetricRow({
  label,
  value,
  highlight,
}: {
  label: string
  value: string
  highlight?: 'green' | 'red'
}) {
  const valueColor = highlight === 'green'
    ? 'text-green-600'
    : highlight === 'red'
      ? 'text-red-600'
      : 'text-gray-900'

  return (
    <div className="flex justify-between items-center">
      <span className="text-sm text-gray-600">{label}</span>
      <span className={`text-sm font-medium ${valueColor}`}>{value}</span>
    </div>
  )
}
