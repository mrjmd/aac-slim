export default function SettingsPage() {
  return (
    <div>
      <h1 className="text-3xl font-bold text-gray-900 mb-8">Settings</h1>

      <div className="space-y-6">
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
