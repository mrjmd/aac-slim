'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'

interface CampaignStats {
  total: number
  queued: number
  sent: number
  failed: number
  skipped: number
  responses: number
  optOuts: number
  responseRate: string
}

interface VariantStats {
  id: string
  message: string
  sent: number
  responses: number
  optOuts: number
  responseRate: string
}

interface Campaign {
  id: string
  name: string
  status: 'pending' | 'running' | 'completed' | 'paused'
  createdAt: string
  messageTemplate: string
  stats: CampaignStats
  abTest?: {
    variants: VariantStats[]
    insights: string[]
  }
}

export default function CampaignDetailPage() {
  const params = useParams()
  const id = params.id as string
  const [campaign, setCampaign] = useState<Campaign | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetchCampaign()
    // Refresh every 10 seconds while running
    const interval = setInterval(() => {
      if (campaign?.status === 'running') {
        fetchCampaign()
      }
    }, 10000)
    return () => clearInterval(interval)
  }, [id, campaign?.status])

  async function fetchCampaign() {
    try {
      const res = await fetch(`/api/campaign/stats?id=${id}`)
      if (!res.ok) {
        if (res.status === 404) throw new Error('Campaign not found')
        throw new Error('Failed to fetch campaign')
      }
      const data = await res.json()
      setCampaign(data.campaign)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }

  function formatDate(dateString: string) {
    return new Date(dateString).toLocaleDateString('en-US', {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    })
  }

  function getStatusBadge(status: Campaign['status']) {
    const styles = {
      pending: 'bg-yellow-100 text-yellow-800',
      running: 'bg-blue-100 text-blue-800',
      completed: 'bg-green-100 text-green-800',
      paused: 'bg-gray-100 text-gray-800',
    }
    return (
      <span className={`inline-flex items-center px-3 py-1 rounded-full text-sm font-medium ${styles[status]}`}>
        {status === 'running' && (
          <span className="w-2 h-2 bg-blue-500 rounded-full mr-2 animate-pulse" />
        )}
        {status.charAt(0).toUpperCase() + status.slice(1)}
      </span>
    )
  }

  if (loading) {
    return (
      <div className="bg-white rounded-lg shadow p-8 text-center text-gray-500">
        Loading campaign...
      </div>
    )
  }

  if (error || !campaign) {
    return (
      <div>
        <Link href="/campaigns" className="text-blue-600 hover:text-blue-700 mb-4 inline-block">
          ← Back to Campaigns
        </Link>
        <div className="bg-red-50 rounded-lg shadow p-8 text-center text-red-600">
          {error || 'Campaign not found'}
        </div>
      </div>
    )
  }

  const progress = campaign.stats.total > 0
    ? Math.round((campaign.stats.sent / campaign.stats.total) * 100)
    : 0

  return (
    <div>
      <Link href="/campaigns" className="text-blue-600 hover:text-blue-700 mb-4 inline-block">
        ← Back to Campaigns
      </Link>

      {/* Header */}
      <div className="flex justify-between items-start mb-8">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">{campaign.name}</h1>
          <p className="text-gray-500 mt-1">{formatDate(campaign.createdAt)}</p>
        </div>
        {getStatusBadge(campaign.status)}
      </div>

      {/* Progress Bar */}
      {campaign.status === 'running' && (
        <div className="bg-white rounded-lg shadow p-6 mb-6">
          <div className="flex justify-between text-sm text-gray-600 mb-2">
            <span>Sending Progress</span>
            <span>{campaign.stats.sent} / {campaign.stats.total} messages</span>
          </div>
          <div className="w-full bg-gray-200 rounded-full h-3">
            <div
              className="bg-blue-600 h-3 rounded-full transition-all duration-500"
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>
      )}

      {/* Stats Grid */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        <StatCard label="Total" value={campaign.stats.total} />
        <StatCard label="Sent" value={campaign.stats.sent} />
        <StatCard label="Responses" value={campaign.stats.responses} color="green" />
        <StatCard label="Response Rate" value={campaign.stats.responseRate} />
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        <StatCard label="Queued" value={campaign.stats.queued} />
        <StatCard label="Skipped" value={campaign.stats.skipped} color="gray" />
        <StatCard label="Failed" value={campaign.stats.failed} color="red" />
        <StatCard label="Opt-Outs" value={campaign.stats.optOuts} color="red" />
      </div>

      {/* Message Template */}
      <div className="bg-white rounded-lg shadow p-6 mb-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-3">Message Template</h2>
        <div className="bg-gray-50 rounded-lg p-4 text-sm text-gray-700 whitespace-pre-wrap">
          {campaign.messageTemplate}
        </div>
      </div>

      {/* A/B Test Results */}
      {campaign.abTest && (
        <div className="bg-white rounded-lg shadow p-6 mb-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">A/B Test Results</h2>

          {/* Insights */}
          {campaign.abTest.insights.length > 0 && (
            <div className="bg-blue-50 rounded-lg p-4 mb-4">
              {campaign.abTest.insights.map((insight, i) => (
                <p key={i} className="text-sm text-blue-800">
                  {insight.startsWith('Warning') ? '⚠️ ' : '💡 '}
                  {insight}
                </p>
              ))}
            </div>
          )}

          {/* Variant Comparison */}
          <div className="grid md:grid-cols-2 gap-4">
            {campaign.abTest.variants.map((variant) => (
              <div key={variant.id} className="border rounded-lg p-4">
                <div className="flex justify-between items-center mb-3">
                  <span className="font-medium text-gray-900">Variant {variant.id}</span>
                  <span className="text-lg font-semibold text-green-600">
                    {variant.responseRate}
                  </span>
                </div>
                <div className="text-sm text-gray-600 mb-3 line-clamp-2">
                  {variant.message}
                </div>
                <div className="flex justify-between text-sm text-gray-500">
                  <span>Sent: {variant.sent}</span>
                  <span>Responses: {variant.responses}</span>
                  <span className={variant.optOuts > 0 ? 'text-red-500' : ''}>
                    Opt-outs: {variant.optOuts}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function StatCard({
  label,
  value,
  color = 'default',
}: {
  label: string
  value: number | string
  color?: 'default' | 'green' | 'red' | 'gray'
}) {
  const colorStyles = {
    default: 'text-gray-900',
    green: 'text-green-600',
    red: 'text-red-600',
    gray: 'text-gray-500',
  }

  return (
    <div className="bg-white rounded-lg shadow p-4">
      <p className="text-sm text-gray-500">{label}</p>
      <p className={`text-2xl font-semibold ${colorStyles[color]}`}>
        {typeof value === 'number' ? value.toLocaleString() : value}
      </p>
    </div>
  )
}
