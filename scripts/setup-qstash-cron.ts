/**
 * Set up QStash cron schedule for follow-up processing
 *
 * Run with: npx tsx scripts/setup-qstash-cron.ts
 *
 * Or set up manually in QStash Dashboard:
 * 1. Go to https://console.upstash.com/qstash
 * 2. Click "Schedules" tab
 * 3. Create new schedule:
 *    - Destination: https://your-domain.vercel.app/api/campaign/process-followups
 *    - Schedule: 0 9 * * * (9 AM daily)
 *    - Method: POST
 */

import 'dotenv/config'

async function setupCron() {
  const token = process.env.QSTASH_TOKEN
  const baseUrl = process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : process.env.NEXT_PUBLIC_APP_URL || 'https://aac-middleware.vercel.app'

  if (!token) {
    console.error('Missing QSTASH_TOKEN environment variable')
    process.exit(1)
  }

  const destination = `${baseUrl}/api/campaign/process-followups`

  console.log('Creating QStash cron schedule...')
  console.log('Destination:', destination)

  // Create schedule - runs at 9 AM UTC daily
  // QStash API uses the destination in the URL path (without encoding)
  const response = await fetch(`https://qstash.upstash.io/v2/schedules/${destination}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Upstash-Cron': '0 9 * * *', // 9 AM UTC daily
    },
  })

  if (!response.ok) {
    const error = await response.text()
    console.error('Failed to create schedule:', error)
    process.exit(1)
  }

  const result = await response.json()
  console.log('QStash cron schedule created successfully!')
  console.log('Schedule ID:', result.scheduleId)
  console.log('Destination:', destination)
  console.log('Schedule: 9 AM UTC daily')
  console.log('')
  console.log('To view or manage this schedule, go to:')
  console.log('https://console.upstash.com/qstash?tab=schedules')
}

setupCron().catch(console.error)
