'use client'

import { useState, useEffect } from 'react'

interface CampaignSettings {
  optOutFooter: string
  throttleSeconds: number
  dailySendLimit: number
  skipWeekends: boolean
  defaultStartHour: number
}

export default function SettingsPage() {
  const [settings, setSettings] = useState<CampaignSettings>({
    optOutFooter: 'Reply STOP to opt out',
    throttleSeconds: 45,
    dailySendLimit: 125,
    skipWeekends: true,
    defaultStartHour: 9,
  })
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    fetchSettings()
  }, [])

  async function fetchSettings() {
    try {
      const res = await fetch('/api/settings')
      if (res.ok) {
        const data = await res.json()
        if (data.campaign) {
          setSettings(data.campaign)
        }
      }
    } catch (err) {
      console.error('Failed to load settings:', err)
    } finally {
      setLoading(false)
    }
  }

  async function saveSettings() {
    setSaving(true)
    setSaved(false)
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ campaign: settings }),
      })
      if (res.ok) {
        setSaved(true)
        setTimeout(() => setSaved(false), 3000)
      }
    } catch (err) {
      console.error('Failed to save settings:', err)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div>
      <h1 className="text-3xl font-bold text-gray-900 mb-8">Settings</h1>

      <div className="space-y-6">
        {/* SMS Campaign Settings */}
        <div className="bg-white rounded-lg shadow p-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">SMS Campaign Settings</h2>

          {loading ? (
            <p className="text-gray-500">Loading...</p>
          ) : (
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Opt-Out Footer
                </label>
                <input
                  type="text"
                  value={settings.optOutFooter}
                  onChange={(e) => setSettings({ ...settings, optOutFooter: e.target.value })}
                  placeholder="Reply STOP to opt out"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-blue-500 focus:border-blue-500"
                />
                <p className="text-xs text-gray-500 mt-1">
                  Appended to all campaign messages. Leave blank to disable.
                </p>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Message Throttle Rate
                </label>
                <div className="flex items-center gap-3">
                  <input
                    type="number"
                    min="1"
                    max="120"
                    step="1"
                    value={settings.throttleSeconds}
                    onChange={(e) => setSettings({ ...settings, throttleSeconds: parseFloat(e.target.value) || 45 })}
                    className="w-24 px-3 py-2 border border-gray-300 rounded-lg focus:ring-blue-500 focus:border-blue-500"
                  />
                  <span className="text-sm text-gray-600">seconds between messages</span>
                </div>
                <p className="text-xs text-gray-500 mt-1">
                  Default: 45 seconds for cold outreach. Lower values increase carrier filtering risk.
                </p>
              </div>

              <div className="border-t border-gray-200 pt-4 mt-4">
                <h3 className="text-sm font-semibold text-gray-800 mb-3">Multi-Day Campaign Settings</h3>
                <p className="text-xs text-gray-500 mb-4">
                  For large lists, campaigns automatically spread across multiple days.
                </p>

                <div className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">
                      Daily Send Limit
                    </label>
                    <div className="flex items-center gap-3">
                      <input
                        type="number"
                        min="10"
                        max="500"
                        step="5"
                        value={settings.dailySendLimit}
                        onChange={(e) => setSettings({ ...settings, dailySendLimit: parseInt(e.target.value) || 125 })}
                        className="w-24 px-3 py-2 border border-gray-300 rounded-lg focus:ring-blue-500 focus:border-blue-500"
                      />
                      <span className="text-sm text-gray-600">messages per day</span>
                    </div>
                    <p className="text-xs text-gray-500 mt-1">
                      2,000 contacts at 125/day = ~16 days to complete
                    </p>
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">
                      Default Start Time
                    </label>
                    <div className="flex items-center gap-3">
                      <select
                        value={settings.defaultStartHour}
                        onChange={(e) => setSettings({ ...settings, defaultStartHour: parseInt(e.target.value) })}
                        className="px-3 py-2 border border-gray-300 rounded-lg focus:ring-blue-500 focus:border-blue-500"
                      >
                        {Array.from({ length: 24 }, (_, i) => (
                          <option key={i} value={i}>
                            {i === 0 ? '12:00 AM' : i < 12 ? `${i}:00 AM` : i === 12 ? '12:00 PM' : `${i - 12}:00 PM`}
                          </option>
                        ))}
                      </select>
                      <span className="text-sm text-gray-600">daily batch start time</span>
                    </div>
                  </div>

                  <div>
                    <label className="flex items-center gap-3 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={settings.skipWeekends}
                        onChange={(e) => setSettings({ ...settings, skipWeekends: e.target.checked })}
                        className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                      />
                      <span className="text-sm font-medium text-gray-700">Skip weekends</span>
                    </label>
                    <p className="text-xs text-gray-500 mt-1 ml-6">
                      Don&apos;t send messages on Saturday or Sunday
                    </p>
                  </div>
                </div>
              </div>

              <div className="pt-4">
                <button
                  onClick={saveSettings}
                  disabled={saving}
                  className="bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700 font-medium disabled:opacity-50"
                >
                  {saving ? 'Saving...' : saved ? 'Saved!' : 'Save Settings'}
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Brand Settings */}
        <div className="bg-white rounded-lg shadow p-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">Brand Settings</h2>
          <p className="text-gray-500">
            Brand voice, visual style, and reference images coming in Phase 4
          </p>
        </div>

        {/* Connected Accounts */}
        <div className="bg-white rounded-lg shadow p-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">Connected Accounts</h2>
          <div className="space-y-4">
            <AccountRow name="Pipedrive" status="connected" />
            <AccountRow name="Quo (OpenPhone)" status="connected" />
            <AccountRow name="QuickBooks" status="connected" />
            <AccountRow name="LinkedIn" status="not_connected" />
            <AccountRow name="Facebook" status="not_connected" />
            <AccountRow name="Instagram" status="not_connected" />
            <AccountRow name="Google Business" status="not_connected" />
          </div>
        </div>
      </div>
    </div>
  )
}

function AccountRow({ name, status }: { name: string; status: 'connected' | 'not_connected' }) {
  return (
    <div className="flex justify-between items-center py-2">
      <span className="text-sm font-medium text-gray-900">{name}</span>
      {status === 'connected' ? (
        <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800">
          Connected
        </span>
      ) : (
        <button className="text-sm text-blue-600 hover:text-blue-700 font-medium">
          Connect
        </button>
      )}
    </div>
  )
}
