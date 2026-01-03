'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'

interface CampaignStats {
  total: number
  queued: number
  sent: number
  failed: number
  skipped: number
  responses: number
  optOuts: number
}

interface Campaign {
  id: string
  name: string
  status: 'pending' | 'running' | 'completed' | 'paused'
  createdAt: string
  hasVariants: boolean
  hasFollowUp?: boolean
  isMultiDay?: boolean
  stats: CampaignStats
}

interface Draft {
  id: string
  name: string
  contactCount: number
  updatedAt: string
  isABTest: boolean
}

export default function CampaignsPage() {
  const [campaigns, setCampaigns] = useState<Campaign[]>([])
  const [archivedCampaigns, setArchivedCampaigns] = useState<Campaign[]>([])
  const [drafts, setDrafts] = useState<Draft[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [showArchived, setShowArchived] = useState(false)

  useEffect(() => {
    fetchCampaigns()
    fetchArchivedCampaigns()
    fetchDrafts()
  }, [])

  async function fetchCampaigns() {
    try {
      const res = await fetch('/api/campaign/stats')
      if (!res.ok) throw new Error('Failed to fetch campaigns')
      const data = await res.json()
      setCampaigns(data.campaigns || [])
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }

  async function fetchArchivedCampaigns() {
    try {
      const res = await fetch('/api/campaign/archive')
      if (!res.ok) return
      const data = await res.json()
      setArchivedCampaigns(data.campaigns || [])
    } catch (err) {
      console.error('Failed to fetch archived campaigns:', err)
    }
  }

  async function archiveCampaign(id: string, name: string) {
    if (!confirm(`Archive campaign "${name}"?`)) return
    try {
      const res = await fetch(`/api/campaign/archive?id=${id}`, { method: 'POST' })
      if (!res.ok) throw new Error('Failed to archive campaign')
      // Move from active to archived
      const campaign = campaigns.find(c => c.id === id)
      if (campaign) {
        setCampaigns(campaigns.filter(c => c.id !== id))
        setArchivedCampaigns([...archivedCampaigns, campaign])
      }
    } catch (err) {
      console.error('Failed to archive campaign:', err)
      alert('Failed to archive campaign')
    }
  }

  async function restoreCampaign(id: string) {
    try {
      const res = await fetch(`/api/campaign/archive?id=${id}`, { method: 'DELETE' })
      if (!res.ok) throw new Error('Failed to restore campaign')
      // Move from archived to active
      const campaign = archivedCampaigns.find(c => c.id === id)
      if (campaign) {
        setArchivedCampaigns(archivedCampaigns.filter(c => c.id !== id))
        setCampaigns([...campaigns, campaign])
      }
    } catch (err) {
      console.error('Failed to restore campaign:', err)
      alert('Failed to restore campaign')
    }
  }

  async function fetchDrafts() {
    try {
      const res = await fetch('/api/campaign/draft')
      if (!res.ok) return
      const data = await res.json()
      setDrafts(data.drafts || [])
    } catch (err) {
      console.error('Failed to fetch drafts:', err)
    }
  }

  async function deleteDraft(id: string) {
    if (!confirm('Delete this draft?')) return
    try {
      await fetch(`/api/campaign/draft?id=${id}`, { method: 'DELETE' })
      setDrafts(drafts.filter(d => d.id !== id))
    } catch (err) {
      console.error('Failed to delete draft:', err)
    }
  }

  async function deleteCampaign(id: string, name: string) {
    if (!confirm(`Delete campaign "${name}"? This cannot be undone.`)) return
    try {
      const res = await fetch(`/api/campaign/delete?id=${id}`, { method: 'DELETE' })
      if (!res.ok) throw new Error('Failed to delete campaign')
      setCampaigns(campaigns.filter(c => c.id !== id))
    } catch (err) {
      console.error('Failed to delete campaign:', err)
      alert('Failed to delete campaign')
    }
  }

  function formatDate(dateString: string) {
    return new Date(dateString).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    })
  }

  function calcResponseRate(stats: CampaignStats): string {
    if (stats.sent === 0) return '0%'
    return ((stats.responses / stats.sent) * 100).toFixed(1) + '%'
  }

  function getStatusBadge(status: Campaign['status']) {
    const styles = {
      pending: 'bg-yellow-100 text-yellow-800',
      running: 'bg-blue-100 text-blue-800',
      completed: 'bg-green-100 text-green-800',
      paused: 'bg-gray-100 text-gray-800',
    }
    return (
      <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${styles[status]}`}>
        {status}
      </span>
    )
  }

  return (
    <div>
      <div className="flex justify-between items-center mb-8">
        <h1 className="text-3xl font-bold text-gray-900">SMS Campaigns</h1>
        <Link
          href="/campaigns/new"
          className="bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700 font-medium"
        >
          New Campaign
        </Link>
      </div>

      {/* Drafts Section */}
      {drafts.length > 0 && (
        <div className="mb-8">
          <h2 className="text-lg font-semibold text-gray-800 mb-3">Drafts</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {drafts.map((draft) => (
              <div
                key={draft.id}
                className="bg-white rounded-lg border border-gray-200 p-4 hover:border-blue-300 transition-colors"
              >
                <div className="flex justify-between items-start mb-2">
                  <h3 className="font-medium text-gray-900 truncate flex-1">
                    {draft.name}
                  </h3>
                  <button
                    onClick={() => deleteDraft(draft.id)}
                    className="text-gray-400 hover:text-red-500 ml-2"
                    title="Delete draft"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </div>
                <div className="text-sm text-gray-600 mb-3">
                  {draft.contactCount.toLocaleString()} contacts
                  {draft.isABTest && (
                    <span className="ml-2 inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-purple-100 text-purple-700">
                      A/B Test
                    </span>
                  )}
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-xs text-gray-500">
                    {formatDate(draft.updatedAt)}
                  </span>
                  <Link
                    href={`/campaigns/new?draft=${draft.id}`}
                    className="text-sm text-blue-600 hover:text-blue-700 font-medium"
                  >
                    Continue editing
                  </Link>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-4 mb-6 border-b border-gray-200">
        <button
          onClick={() => setShowArchived(false)}
          className={`pb-2 px-1 font-medium text-sm ${
            !showArchived
              ? 'text-blue-600 border-b-2 border-blue-600'
              : 'text-gray-500 hover:text-gray-700'
          }`}
        >
          Active ({campaigns.length})
        </button>
        <button
          onClick={() => setShowArchived(true)}
          className={`pb-2 px-1 font-medium text-sm ${
            showArchived
              ? 'text-blue-600 border-b-2 border-blue-600'
              : 'text-gray-500 hover:text-gray-700'
          }`}
        >
          Archived ({archivedCampaigns.length})
        </button>
      </div>

      {loading ? (
        <div className="bg-white rounded-lg shadow p-8 text-center text-gray-500">
          Loading campaigns...
        </div>
      ) : error ? (
        <div className="bg-red-50 rounded-lg shadow p-8 text-center text-red-600">
          {error}
        </div>
      ) : (showArchived ? archivedCampaigns : campaigns).length === 0 ? (
        <div className="bg-white rounded-lg shadow">
          <div className="px-6 py-12 text-center">
            <p className="text-gray-500 mb-4">
              {showArchived ? 'No archived campaigns' : 'No campaigns yet'}
            </p>
            {!showArchived && (
              <Link
                href="/campaigns/new"
                className="text-blue-600 hover:text-blue-700 font-medium"
              >
                Create your first campaign
              </Link>
            )}
          </div>
        </div>
      ) : (
        <div className="bg-white rounded-lg shadow overflow-hidden">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Campaign
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Status
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Sent
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Responses
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Rate
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Created
                </th>
                <th className="px-6 py-3"></th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {(showArchived ? archivedCampaigns : campaigns).map((campaign) => (
                <tr key={campaign.id} className="hover:bg-gray-50">
                  <td className="px-6 py-4">
                    <div className="flex items-center">
                      <div>
                        <div className="text-sm font-medium text-gray-900">
                          {campaign.name}
                        </div>
                        <div className="text-sm text-gray-500 flex flex-wrap gap-1 mt-1">
                          {campaign.hasVariants && (
                            <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-purple-100 text-purple-800">
                              A/B Test
                            </span>
                          )}
                          {campaign.hasFollowUp && (
                            <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-amber-100 text-amber-800">
                              Follow-up
                            </span>
                          )}
                          {campaign.isMultiDay && (
                            <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-indigo-100 text-indigo-800">
                              Multi-day
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    {getStatusBadge(campaign.status)}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                    {campaign.stats.sent.toLocaleString()}
                    <span className="text-gray-500">
                      /{campaign.stats.total.toLocaleString()}
                    </span>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                    {campaign.stats.responses.toLocaleString()}
                    {campaign.stats.optOuts > 0 && (
                      <span className="text-red-500 ml-1">
                        (-{campaign.stats.optOuts})
                      </span>
                    )}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                    {calcResponseRate(campaign.stats)}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                    {formatDate(campaign.createdAt)}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                    <Link
                      href={`/campaigns/${campaign.id}`}
                      className="text-blue-600 hover:text-blue-900 mr-3"
                    >
                      View
                    </Link>
                    {showArchived ? (
                      <button
                        onClick={() => restoreCampaign(campaign.id)}
                        className="text-green-600 hover:text-green-800 mr-3"
                        title="Restore campaign"
                      >
                        Restore
                      </button>
                    ) : (
                      <button
                        onClick={() => archiveCampaign(campaign.id, campaign.name)}
                        className="text-gray-400 hover:text-gray-600 mr-3"
                        title="Archive campaign"
                      >
                        <svg className="w-4 h-4 inline-block" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4" />
                        </svg>
                      </button>
                    )}
                    <button
                      onClick={() => deleteCampaign(campaign.id, campaign.name)}
                      className="text-gray-400 hover:text-red-600"
                      title="Delete campaign"
                    >
                      <svg className="w-4 h-4 inline-block" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                      </svg>
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
