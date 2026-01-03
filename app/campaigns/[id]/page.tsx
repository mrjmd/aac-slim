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

interface MultiDayConfig {
  dailyLimit: number
  skipWeekends: boolean
  startHour: number
  totalContacts: number
  currentDay: number
  nextBatchAt?: string
}

interface FollowUpConfig {
  delayDays: number
  message: string
  sent: number
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
  multiDay?: MultiDayConfig
  followUp?: FollowUpConfig
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

  async function pauseCampaign() {
    if (!confirm('Pause this campaign? Messages in queue will be skipped.')) return
    try {
      const res = await fetch(`/api/campaign/pause?id=${id}`, { method: 'POST' })
      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error || 'Failed to pause campaign')
      }
      fetchCampaign()
    } catch (err) {
      alert((err as Error).message)
    }
  }

  async function resumeCampaign() {
    try {
      const res = await fetch(`/api/campaign/pause?id=${id}`, { method: 'DELETE' })
      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error || 'Failed to resume campaign')
      }
      fetchCampaign()
    } catch (err) {
      alert((err as Error).message)
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
        <div className="flex items-center gap-3">
          {getStatusBadge(campaign.status)}
          {campaign.status === 'running' && (
            <button
              onClick={pauseCampaign}
              className="px-3 py-1.5 text-sm font-medium text-yellow-700 bg-yellow-100 hover:bg-yellow-200 rounded-lg transition-colors"
            >
              Pause
            </button>
          )}
          {campaign.status === 'paused' && (
            <button
              onClick={resumeCampaign}
              className="px-3 py-1.5 text-sm font-medium text-green-700 bg-green-100 hover:bg-green-200 rounded-lg transition-colors"
            >
              Resume
            </button>
          )}
        </div>
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

      {/* Multi-Day Campaign Progress */}
      {campaign.multiDay && (() => {
        const totalDays = Math.ceil(campaign.multiDay.totalContacts / campaign.multiDay.dailyLimit)
        const daysRemaining = Math.max(0, Math.ceil((campaign.multiDay.totalContacts - campaign.stats.sent - campaign.stats.skipped - campaign.stats.failed) / campaign.multiDay.dailyLimit))
        const dayProgress = Math.round((campaign.multiDay.currentDay / totalDays) * 100)

        return (
          <div className="bg-white rounded-lg shadow p-6 mb-6">
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-lg font-semibold text-gray-900">Multi-Day Campaign</h2>
              <span className="text-2xl font-bold text-indigo-600">
                Day {campaign.multiDay.currentDay} of {totalDays}
              </span>
            </div>

            {/* Day Progress Bar */}
            <div className="mb-4">
              <div className="flex justify-between text-sm text-gray-600 mb-1">
                <span>Campaign Progress</span>
                <span>{campaign.multiDay.currentDay} / {totalDays} days</span>
              </div>
              <div className="w-full bg-gray-200 rounded-full h-2">
                <div
                  className="bg-indigo-500 h-2 rounded-full transition-all duration-500"
                  style={{ width: `${dayProgress}%` }}
                />
              </div>
            </div>

            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
              <div>
                <p className="text-sm text-gray-500">Daily Limit</p>
                <p className="text-xl font-semibold text-gray-900">
                  {campaign.multiDay.dailyLimit} / day
                </p>
              </div>
              <div>
                <p className="text-sm text-gray-500">Total Contacts</p>
                <p className="text-xl font-semibold text-gray-900">
                  {campaign.multiDay.totalContacts.toLocaleString()}
                </p>
              </div>
              <div>
                <p className="text-sm text-gray-500">Days Remaining</p>
                <p className="text-xl font-semibold text-gray-900">
                  {daysRemaining}
                </p>
              </div>
              <div>
                <p className="text-sm text-gray-500">Start Time</p>
                <p className="text-xl font-semibold text-gray-900">
                  {campaign.multiDay.startHour}:00
                </p>
              </div>
            </div>

            {campaign.multiDay.nextBatchAt && (
              <div className="bg-blue-50 rounded-lg p-4">
                <p className="text-sm text-blue-800">
                  <span className="font-medium">Next batch scheduled:</span>{' '}
                  {formatDate(campaign.multiDay.nextBatchAt)}
                </p>
                {campaign.multiDay.skipWeekends && (
                  <p className="text-xs text-blue-600 mt-1">
                    Weekends are skipped
                  </p>
                )}
              </div>
            )}

            {!campaign.multiDay.nextBatchAt && campaign.status === 'running' && (
              <div className="bg-yellow-50 rounded-lg p-4">
                <p className="text-sm text-yellow-800">
                  Final batch in progress - campaign will complete when all messages are sent
                </p>
              </div>
            )}

            {campaign.status === 'completed' && (
              <div className="bg-green-50 rounded-lg p-4">
                <p className="text-sm text-green-800">
                  Campaign completed after {campaign.multiDay.currentDay} days
                </p>
              </div>
            )}
          </div>
        )
      })()}

      {/* Follow-Up Message */}
      {campaign.followUp && (
        <div className="bg-white rounded-lg shadow p-6 mb-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">Follow-Up Message</h2>

          <div className="grid grid-cols-2 md:grid-cols-3 gap-4 mb-4">
            <div>
              <p className="text-sm text-gray-500">Delay</p>
              <p className="text-xl font-semibold text-gray-900">
                {campaign.followUp.delayDays} day{campaign.followUp.delayDays !== 1 ? 's' : ''}
              </p>
            </div>
            <div>
              <p className="text-sm text-gray-500">Non-Responders</p>
              <p className="text-xl font-semibold text-gray-900">
                {(campaign.stats.sent - campaign.stats.responses).toLocaleString()}
              </p>
            </div>
            <div>
              <p className="text-sm text-gray-500">Follow-Ups Sent</p>
              <p className="text-xl font-semibold text-amber-600">
                {campaign.followUp.sent.toLocaleString()}
              </p>
            </div>
          </div>

          <div className="bg-amber-50 rounded-lg p-4">
            <p className="text-xs font-medium text-amber-700 mb-2">Follow-Up Message:</p>
            <p className="text-sm text-amber-900 whitespace-pre-wrap">
              {campaign.followUp.message}
            </p>
          </div>
        </div>
      )}

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
