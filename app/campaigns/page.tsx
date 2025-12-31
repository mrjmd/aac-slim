export default function CampaignsPage() {
  return (
    <div>
      <div className="flex justify-between items-center mb-8">
        <h1 className="text-3xl font-bold text-gray-900">SMS Campaigns</h1>
        <button className="bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700 font-medium">
          New Campaign
        </button>
      </div>

      <div className="bg-white rounded-lg shadow">
        <div className="px-6 py-4 border-b border-gray-200">
          <p className="text-sm text-gray-500">
            Campaign management UI coming soon. Currently use CLI:
          </p>
          <code className="mt-2 block text-sm bg-gray-100 p-2 rounded">
            npm run campaign:start -- --csv=file.csv --name=&quot;Campaign&quot; --message=&quot;Hi &#123;firstName&#125;...&quot;
          </code>
        </div>

        <div className="divide-y divide-gray-200">
          <div className="px-6 py-8 text-center text-gray-500">
            No campaigns yet
          </div>
        </div>
      </div>
    </div>
  )
}
