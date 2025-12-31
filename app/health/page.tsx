export default function HealthPage() {
  return (
    <div>
      <h1 className="text-3xl font-bold text-gray-900 mb-8">System Health</h1>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Webhook Stats */}
        <div className="bg-white rounded-lg shadow p-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">Webhook Processing (24h)</h2>
          <div className="space-y-3">
            <MetricRow label="Pipedrive webhooks" value="-" />
            <MetricRow label="Quo webhooks" value="-" />
            <MetricRow label="Google Ads webhooks" value="-" />
          </div>
        </div>

        {/* Sync Status */}
        <div className="bg-white rounded-lg shadow p-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">Sync Coverage</h2>
          <div className="space-y-3">
            <MetricRow label="PD → Quo mappings" value="-" />
            <MetricRow label="PD → QB mappings" value="-" />
            <MetricRow label="Phone → PD mappings" value="-" />
          </div>
        </div>

        {/* Recent Errors */}
        <div className="bg-white rounded-lg shadow p-6 lg:col-span-2">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">Recent Errors</h2>
          <div className="text-center py-8 text-gray-500">
            No errors in the last 24 hours
          </div>
        </div>

        {/* Queue Status */}
        <div className="bg-white rounded-lg shadow p-6 lg:col-span-2">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">QStash Queue</h2>
          <div className="space-y-3">
            <MetricRow label="Pending messages" value="-" />
            <MetricRow label="Failed (retry pending)" value="-" />
          </div>
        </div>
      </div>
    </div>
  )
}

function MetricRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between items-center">
      <span className="text-sm text-gray-600">{label}</span>
      <span className="text-sm font-medium text-gray-900">{value}</span>
    </div>
  )
}
