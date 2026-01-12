/**
 * Debug script for multi-day campaign batch scheduling
 * Usage: npx ts-node scripts/debug-campaign-batch.ts <campaign-id>
 */

import { Redis } from '@upstash/redis'
import * as dotenv from 'dotenv'

// Load .env.local first, then fall back to .env
dotenv.config({ path: '.env.local' })
dotenv.config()

if (!process.env.UPSTASH_REDIS_REST_URL) {
  console.error('Missing UPSTASH_REDIS_REST_URL')
  console.error('Make sure .env or .env.local contains UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN')
  process.exit(1)
}

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
})

async function main() {
  const campaignId = process.argv[2]

  if (!campaignId) {
    // List all active campaigns
    console.log('\n📋 Active campaigns:')
    const activeCampaigns = await redis.smembers('campaigns:active')

    for (const id of activeCampaigns) {
      const raw = await redis.get(`campaign:${id}`)
      if (raw) {
        // Redis may return parsed object or string depending on how it was stored
        const campaign = typeof raw === 'string' ? JSON.parse(raw) : raw
        console.log(`\n  ${id}:`)
        console.log(`    Name: ${campaign.name}`)
        console.log(`    Status: ${campaign.status}`)
        console.log(`    Created: ${campaign.createdAt}`)
        if (campaign.multiDay) {
          console.log(`    Multi-day: Day ${campaign.multiDay.currentDay || 1}`)
          console.log(`    Next batch: ${campaign.multiDay.nextBatchAt || 'None scheduled'}`)
          console.log(`    Daily limit: ${campaign.multiDay.dailyLimit}`)
        }
        console.log(`    Stats: sent=${campaign.stats.sent}, queued=${campaign.stats.queued}, failed=${campaign.stats.failed}`)
      }
    }

    console.log('\n\nUsage: npx ts-node scripts/debug-campaign-batch.ts <campaign-id>')
    return
  }

  console.log(`\n🔍 Debugging campaign: ${campaignId}\n`)

  // Get campaign data
  const campaignRaw = await redis.get(`campaign:${campaignId}`)
  if (!campaignRaw) {
    console.error('❌ Campaign not found')
    return
  }

  const campaign = typeof campaignRaw === 'string' ? JSON.parse(campaignRaw) : campaignRaw
  console.log('📊 Campaign Details:')
  console.log(`  Name: ${campaign.name}`)
  console.log(`  Status: ${campaign.status}`)
  console.log(`  Created: ${campaign.createdAt}`)
  console.log(`  Message template: ${campaign.messageTemplate?.substring(0, 50)}...`)

  console.log('\n📈 Stats:')
  console.log(`  Total: ${campaign.stats.total}`)
  console.log(`  Queued: ${campaign.stats.queued}`)
  console.log(`  Sent: ${campaign.stats.sent}`)
  console.log(`  Failed: ${campaign.stats.failed}`)
  console.log(`  Skipped: ${campaign.stats.skipped}`)
  console.log(`  Responses: ${campaign.stats.responses}`)
  console.log(`  Opt-outs: ${campaign.stats.optOuts}`)

  if (campaign.multiDay) {
    console.log('\n📅 Multi-Day Config:')
    console.log(`  Daily limit: ${campaign.multiDay.dailyLimit}`)
    console.log(`  Skip weekends: ${campaign.multiDay.skipWeekends}`)
    console.log(`  Start hour: ${campaign.multiDay.startHour}`)
    console.log(`  Total contacts: ${campaign.multiDay.totalContacts}`)
    console.log(`  Current day: ${campaign.multiDay.currentDay || 1}`)
    console.log(`  Next batch at: ${campaign.multiDay.nextBatchAt || 'None scheduled'}`)

    if (campaign.multiDay.nextBatchAt) {
      const nextBatch = new Date(campaign.multiDay.nextBatchAt)
      const now = new Date()
      const diff = nextBatch.getTime() - now.getTime()

      if (diff < 0) {
        const minutesAgo = Math.floor(-diff / 60000)
        console.log(`\n⚠️  PROBLEM: Next batch was scheduled ${minutesAgo} minutes ago but hasn't run!`)
        console.log(`   Scheduled time: ${nextBatch.toISOString()}`)
        console.log(`   Current time:   ${now.toISOString()}`)
      } else {
        const minutesUntil = Math.floor(diff / 60000)
        console.log(`\n✅ Next batch in ${minutesUntil} minutes`)
      }
    }
  }

  // Check pending contacts
  const pendingKey = `campaign:${campaignId}:pending`
  const pendingRaw = await redis.get(pendingKey)

  if (pendingRaw) {
    const pending = typeof pendingRaw === 'string' ? JSON.parse(pendingRaw) : pendingRaw
    console.log(`\n📝 Pending contacts: ${pending.length}`)
    if (pending.length > 0) {
      console.log(`   First pending: ${pending[0].firstName} ${pending[0].phone}`)
    }
  } else {
    console.log('\n📝 No pending contacts (all batches sent or campaign is single-day)')
  }

  // Suggest fix if batch is overdue
  if (campaign.multiDay?.nextBatchAt) {
    const nextBatch = new Date(campaign.multiDay.nextBatchAt)
    const now = new Date()
    if (nextBatch.getTime() < now.getTime()) {
      console.log('\n🔧 SUGGESTED FIX:')
      console.log('   The batch scheduler appears to have failed. You can manually trigger')
      console.log('   the next batch by calling the process-batch endpoint.')
      console.log('')
      console.log('   Run this command to trigger the batch manually:')
      console.log(`   curl -X POST https://aac-middleware.vercel.app/api/campaign/process-batch \\`)
      console.log(`     -H "Content-Type: application/json" \\`)
      console.log(`     -d '{"campaignId": "${campaignId}", "optOutFooter": "Reply STOP to unsubscribe", "throttleSeconds": 5}'`)
      console.log('')
      console.log('   Note: This endpoint requires QStash signature verification.')
      console.log('   Use the debug API endpoint instead for manual triggering.')
    }
  }
}

main().catch(console.error)
