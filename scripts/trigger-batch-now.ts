/**
 * Manually trigger a multi-day campaign batch
 * Usage: npx tsx scripts/trigger-batch-now.ts <campaign-id>
 *
 * This script bypasses QStash scheduling and triggers the batch directly.
 * Use when QStash scheduled messages fail to trigger.
 */

import { Redis } from '@upstash/redis'
import { Client } from '@upstash/qstash'
import * as dotenv from 'dotenv'

dotenv.config({ path: '.env.local' })
dotenv.config()

if (!process.env.UPSTASH_REDIS_REST_URL) {
  console.error('Missing UPSTASH_REDIS_REST_URL')
  process.exit(1)
}

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
})

const qstash = new Client({
  token: process.env.QSTASH_TOKEN!,
})

interface NormalizedContact {
  firstName: string
  lastName: string | null
  phone: string
  email: string | null
  city: string
  subdivision: string | null
  address: string | null
  zip: string | null
}

// Normalize to title case: "QUINCY" -> "Quincy", "south boston" -> "South Boston"
function toTitleCase(str: string): string {
  if (!str) return ''
  return str
    .toLowerCase()
    .split(' ')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}

function personalizeMessage(template: string, contact: NormalizedContact): string {
  return template
    .replace(/\{firstName\}/g, toTitleCase(contact.firstName))
    .replace(/\{lastName\}/g, toTitleCase(contact.lastName || ''))
    .replace(/\{city\}/g, toTitleCase(contact.city))
    .replace(/\{neighborhood\}/g, toTitleCase(contact.subdivision || contact.city))
}

async function createPipedriveContact(contact: NormalizedContact, _campaignName: string): Promise<{ id: number; created: boolean }> {
  const apiKey = process.env.PIPEDRIVE_API_KEY
  const domain = process.env.PIPEDRIVE_COMPANY_DOMAIN

  const searchRes = await fetch(
    `https://${domain}.pipedrive.com/api/v1/persons/search?term=${encodeURIComponent(contact.phone)}&fields=phone&api_token=${apiKey}`
  )
  const searchData = await searchRes.json()

  if (searchData.data?.items?.length > 0) {
    return { id: searchData.data.items[0].item.id, created: false }
  }

  const createRes = await fetch(
    `https://${domain}.pipedrive.com/api/v1/persons?api_token=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: `${contact.firstName} ${contact.lastName || ''}`.trim(),
        phone: [{ value: contact.phone, primary: true, label: 'mobile' }],
        email: contact.email ? [{ value: contact.email, primary: true, label: 'work' }] : undefined,
        visible_to: 3,
      }),
    }
  )
  const createData = await createRes.json()
  return { id: createData.data.id, created: true }
}

function calculateNextBatchTime(startHour: number, skipWeekends: boolean): Date {
  const next = new Date()
  next.setDate(next.getDate() + 1)
  next.setHours(startHour, 0, 0, 0)

  if (skipWeekends) {
    while (next.getDay() === 0 || next.getDay() === 6) {
      next.setDate(next.getDate() + 1)
    }
  }

  return next
}

async function main() {
  const campaignId = process.argv[2]

  if (!campaignId) {
    console.error('Usage: npx tsx scripts/trigger-batch-now.ts <campaign-id>')
    console.error('')
    console.error('To see active campaigns: npx tsx scripts/debug-campaign-batch.ts')
    process.exit(1)
  }

  console.log(`\n🚀 Manually triggering batch for campaign: ${campaignId}\n`)

  // Get campaign data
  const campaignRaw = await redis.get(`campaign:${campaignId}`)
  if (!campaignRaw) {
    console.error('❌ Campaign not found')
    process.exit(1)
  }

  const campaign = typeof campaignRaw === 'string' ? JSON.parse(campaignRaw) : campaignRaw
  if (!campaign.multiDay) {
    console.error('❌ Not a multi-day campaign')
    process.exit(1)
  }

  console.log(`📊 Campaign: ${campaign.name}`)
  console.log(`   Day ${campaign.multiDay.currentDay || 1}, Daily limit: ${campaign.multiDay.dailyLimit}`)

  // Get pending contacts
  const pendingKey = `campaign:${campaignId}:pending`
  const pendingRaw = await redis.get(pendingKey)
  if (!pendingRaw) {
    console.log('\n✅ No pending contacts - all batches already sent')
    process.exit(0)
  }

  const allContacts: NormalizedContact[] = typeof pendingRaw === 'string' ? JSON.parse(pendingRaw) : pendingRaw
  const batchSize = campaign.multiDay.dailyLimit
  const batch = allContacts.slice(0, batchSize)
  const remaining = allContacts.slice(batchSize)

  console.log(`\n📝 Processing batch:`)
  console.log(`   Batch size: ${batch.length}`)
  console.log(`   Remaining after this batch: ${remaining.length}`)

  // Confirm before proceeding
  console.log(`\n⚠️  This will queue ${batch.length} messages to QStash.`)
  console.log(`   Press Ctrl+C within 5 seconds to cancel...`)
  await new Promise(resolve => setTimeout(resolve, 5000))

  console.log(`\n🔄 Starting batch processing...\n`)

  // Update pending contacts first
  if (remaining.length > 0) {
    await redis.set(pendingKey, JSON.stringify(remaining))
  } else {
    await redis.del(pendingKey)
  }

  const callbackUrl = 'https://aac-middleware.vercel.app/api/campaign/send'
  const batchCallbackUrl = 'https://aac-middleware.vercel.app/api/campaign/process-batch'
  const optOutFooter = 'Reply STOP to unsubscribe'
  const throttleSeconds = 5

  let queueIndex = 0
  let queued = 0
  let pipedriveCreated = 0

  for (const contact of batch) {
    let messageTemplate = campaign.messageTemplate
    let variantId: string | undefined

    if (campaign.variants && campaign.variants.length > 0) {
      const randomVariant = campaign.variants[Math.random() < 0.5 ? 0 : 1]
      messageTemplate = randomVariant.message
      variantId = randomVariant.id
    }

    let personalizedMessage = personalizeMessage(messageTemplate, contact)
    if (optOutFooter) {
      personalizedMessage = `${personalizedMessage}\n\n${optOutFooter}`
    }

    // Create Pipedrive contact
    try {
      const { id: personId, created } = await createPipedriveContact(contact, campaign.name)
      if (created) pipedriveCreated++

      // Queue message via QStash
      const delay = Math.floor(queueIndex * throttleSeconds)
      await qstash.publishJSON({
        url: callbackUrl,
        delay,
        body: {
          campaignId,
          pipedrivePersonId: personId,
          phone: contact.phone,
          message: personalizedMessage,
          variant: variantId,
        },
      })

      campaign.stats.queued = (campaign.stats.queued || 0) + 1
      queued++
      queueIndex++

      // Progress indicator
      if (queued % 10 === 0 || queued === batch.length) {
        console.log(`   ✓ Queued ${queued}/${batch.length} messages`)
      }
    } catch (error) {
      console.error(`   ✗ Failed to process ${contact.phone}: ${(error as Error).message}`)
    }
  }

  // Update campaign day count
  campaign.multiDay.currentDay = (campaign.multiDay.currentDay || 1) + 1

  // Schedule next batch if there are more contacts
  if (remaining.length > 0) {
    const nextTime = calculateNextBatchTime(campaign.multiDay.startHour, campaign.multiDay.skipWeekends)
    const delaySeconds = Math.max(0, Math.floor((nextTime.getTime() - Date.now()) / 1000))

    console.log(`\n📅 Scheduling next batch for ${nextTime.toISOString()}`)
    console.log(`   Delay: ${delaySeconds} seconds (${Math.round(delaySeconds / 3600)} hours)`)

    await qstash.publishJSON({
      url: batchCallbackUrl,
      delay: delaySeconds,
      body: {
        campaignId,
        optOutFooter,
        throttleSeconds,
      },
    })

    campaign.multiDay.nextBatchAt = nextTime.toISOString()
  } else {
    console.log(`\n✅ This was the last batch - no more contacts remaining`)
    campaign.multiDay.nextBatchAt = null
  }

  await redis.set(`campaign:${campaignId}`, JSON.stringify(campaign))

  console.log(`\n🎉 Batch complete!`)
  console.log(`   Queued: ${queued}`)
  console.log(`   Pipedrive contacts created: ${pipedriveCreated}`)
  console.log(`   Remaining contacts: ${remaining.length}`)
  console.log(`   Campaign day: ${campaign.multiDay.currentDay}`)
  if (campaign.multiDay.nextBatchAt) {
    console.log(`   Next batch: ${campaign.multiDay.nextBatchAt}`)
  }
}

main().catch(console.error)
