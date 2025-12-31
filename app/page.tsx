export default function Dashboard() {
  return (
    <div>
      <h1 className="text-3xl font-bold text-gray-900 mb-8">Dashboard</h1>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {/* Quick Stats */}
        <div className="bg-white rounded-lg shadow p-6">
          <h2 className="text-sm font-medium text-gray-500 uppercase tracking-wide">Active Campaigns</h2>
          <p className="mt-2 text-3xl font-semibold text-gray-900">-</p>
        </div>

        <div className="bg-white rounded-lg shadow p-6">
          <h2 className="text-sm font-medium text-gray-500 uppercase tracking-wide">Messages Sent (24h)</h2>
          <p className="mt-2 text-3xl font-semibold text-gray-900">-</p>
        </div>

        <div className="bg-white rounded-lg shadow p-6">
          <h2 className="text-sm font-medium text-gray-500 uppercase tracking-wide">Response Rate</h2>
          <p className="mt-2 text-3xl font-semibold text-gray-900">-</p>
        </div>
      </div>

      {/* System Status */}
      <div className="mt-8">
        <h2 className="text-xl font-semibold text-gray-900 mb-4">System Status</h2>
        <div className="bg-white rounded-lg shadow overflow-hidden">
          <div className="divide-y divide-gray-200">
            <StatusRow name="Pipedrive Webhook" status="unknown" />
            <StatusRow name="Quo Webhook" status="unknown" />
            <StatusRow name="QuickBooks Sync" status="unknown" />
            <StatusRow name="QStash Queue" status="unknown" />
          </div>
        </div>
      </div>
    </div>
  )
}

function StatusRow({ name, status }: { name: string; status: 'healthy' | 'degraded' | 'down' | 'unknown' }) {
  const statusColors = {
    healthy: 'bg-green-100 text-green-800',
    degraded: 'bg-yellow-100 text-yellow-800',
    down: 'bg-red-100 text-red-800',
    unknown: 'bg-gray-100 text-gray-800',
  }

  return (
    <div className="px-6 py-4 flex items-center justify-between">
      <span className="text-sm font-medium text-gray-900">{name}</span>
      <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${statusColors[status]}`}>
        {status}
      </span>
    </div>
  )
}
