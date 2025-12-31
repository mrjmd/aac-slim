#!/usr/bin/env npx tsx
/**
 * Campaign Runner CLI
 *
 * Imports Property Radar CSV, creates Pipedrive contacts,
 * and queues SMS messages via QStash.
 *
 * Usage:
 *   npx tsx scripts/run-campaign.ts \
 *     --csv="Export-20250115.csv" \
 *     --name="2025-01-15-Braintree" \
 *     --message="Hi {firstName}, I noticed you're a homeowner in {city}..."
 */

import { parseArgs } from 'node:util';
import { parsePropertyRadarFile, type NormalizedContact } from '../src/lib/csv-parser.js';
import { hasExistingConversation } from '../src/clients/quo.js';
import { createCampaignContact } from '../src/clients/pipedrive.js';
import { createCampaign, incrementCampaignStats, updateCampaignStatus } from '../src/lib/redis.js';
import { queueMessage, calculateDelay } from '../src/lib/queue.js';
import { getEnv } from '../src/lib/env.js';

// Parse CLI arguments
const { values } = parseArgs({
  options: {
    csv: { type: 'string', short: 'c' },
    name: { type: 'string', short: 'n' },
    message: { type: 'string', short: 'm' },
    'dry-run': { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h' },
  },
});

function printHelp() {
  console.log(`
Campaign Runner CLI

Usage:
  npx tsx scripts/run-campaign.ts --csv=<file> --name=<name> --message=<template>

Options:
  --csv, -c       Path to Property Radar CSV export (required)
  --name, -n      Campaign name, e.g., "2025-01-15-Braintree" (required)
  --message, -m   Message template with {firstName} and {city} placeholders (required)
  --dry-run       Process CSV but don't queue messages or create contacts
  --help, -h      Show this help

Example:
  npx tsx scripts/run-campaign.ts \\
    --csv="exports/Export-20250115.csv" \\
    --name="2025-01-15-Braintree" \\
    --message="Hi {firstName}, I noticed you're a homeowner in {city}. We're doing exterior work in your area. Would you like a free estimate?"
`);
}

if (values.help) {
  printHelp();
  process.exit(0);
}

// Validate required args
if (!values.csv || !values.name || !values.message) {
  console.error('Error: --csv, --name, and --message are required\n');
  printHelp();
  process.exit(1);
}

const isDryRun = values['dry-run'];

/**
 * Personalize a message template with contact data
 */
function personalizeMessage(template: string, contact: NormalizedContact): string {
  return template
    .replace(/\{firstName\}/g, contact.firstName)
    .replace(/\{lastName\}/g, contact.lastName || '')
    .replace(/\{city\}/g, contact.city)
    .replace(/\{neighborhood\}/g, contact.subdivision || contact.city);
}

/**
 * Format a number with commas
 */
function formatNumber(n: number): string {
  return n.toLocaleString();
}

async function main() {
  console.log('\n🚀 Campaign Runner\n');

  // Load environment (validates required vars)
  const env = getEnv();
  console.log(`📱 Sending from: ${env.quo.phoneNumber}`);
  console.log(`📊 Campaign: ${values.name}`);

  if (isDryRun) {
    console.log('⚠️  DRY RUN MODE - No messages will be sent\n');
  }

  // Parse CSV
  console.log(`\n📄 Parsing CSV: ${values.csv}`);
  const { contacts, stats: parseStats } = await parsePropertyRadarFile(values.csv!);

  console.log(`   Total rows: ${formatNumber(parseStats.totalRows)}`);
  console.log(`   Primary contacts: ${formatNumber(parseStats.primaryContacts)}`);
  console.log(`   Secondary contacts: ${formatNumber(parseStats.secondaryContacts)}`);
  console.log(`   Skipped (no phone): ${formatNumber(parseStats.skippedNoPhone)}`);
  console.log(`   Skipped (inactive): ${formatNumber(parseStats.skippedInactivePhone)}`);
  console.log(`   Skipped (invalid): ${formatNumber(parseStats.skippedInvalidPhone)}`);
  console.log(`   → ${formatNumber(contacts.length)} contacts to process\n`);

  if (contacts.length === 0) {
    console.log('❌ No valid contacts found. Exiting.\n');
    process.exit(1);
  }

  // Create campaign in Redis
  const campaignId = `campaign-${values.name!.toLowerCase().replace(/[^a-z0-9-]/g, '-')}`;

  if (!isDryRun) {
    await createCampaign(campaignId, values.name!, values.message!);
    await incrementCampaignStats(campaignId, { total: contacts.length });
  }

  console.log(`🎯 Campaign ID: ${campaignId}\n`);

  // Build the callback URL for QStash
  const callbackUrl = `${process.env.VERCEL_URL || 'https://aac-middleware.vercel.app'}/api/campaign/send`;

  // Process contacts
  console.log('🔍 Checking Quo for existing conversations...\n');

  let queued = 0;
  let skipped = 0;
  let pipedriveCreated = 0;
  let queueIndex = 0;

  for (let i = 0; i < contacts.length; i++) {
    const contact = contacts[i];
    const progress = `[${i + 1}/${contacts.length}]`;

    // Check if we've already messaged this person via Quo
    const hasConversation = await hasExistingConversation(contact.phone);

    if (hasConversation) {
      console.log(`${progress} ⏭️  ${contact.phone} - Already contacted, skipping`);
      skipped++;

      if (!isDryRun) {
        await incrementCampaignStats(campaignId, { skipped: 1 });
      }
      continue;
    }

    // Create Pipedrive contact (if not dry run)
    let pipedrivePersonId = 0;
    if (!isDryRun) {
      const { person, created } = await createCampaignContact({
        firstName: contact.firstName,
        lastName: contact.lastName,
        phone: contact.phone,
        email: contact.email,
        address: contact.address,
        city: contact.city,
        zip: contact.zip,
        campaignName: values.name!,
      });
      pipedrivePersonId = person.id;
      if (created) pipedriveCreated++;
    }

    // Personalize the message
    const personalizedMessage = personalizeMessage(values.message!, contact);

    // Validate message length
    if (personalizedMessage.length > 160) {
      console.log(`${progress} ⚠️  ${contact.phone} - Message too long (${personalizedMessage.length} chars)`);
    }

    // Queue the message
    if (!isDryRun) {
      const delay = calculateDelay(queueIndex);
      await queueMessage(
        {
          campaignId,
          pipedrivePersonId,
          phone: contact.phone,
          message: personalizedMessage,
        },
        delay,
        callbackUrl
      );
      await incrementCampaignStats(campaignId, { queued: 1 });
    }

    console.log(`${progress} ✅ ${contact.phone} - ${contact.firstName} in ${contact.city}`);
    queued++;
    queueIndex++;
  }

  // Update campaign status
  if (!isDryRun) {
    await updateCampaignStatus(campaignId, 'running');
  }

  // Summary
  const estimatedMinutes = Math.ceil((queued * 2.5) / 60);

  console.log('\n' + '='.repeat(50));
  console.log('📊 Campaign Summary');
  console.log('='.repeat(50));
  console.log(`   Campaign: ${values.name}`);
  console.log(`   Status: ${isDryRun ? 'DRY RUN' : 'Running'}`);
  console.log(`   Queued: ${formatNumber(queued)}`);
  console.log(`   Skipped (already contacted): ${formatNumber(skipped)}`);
  console.log(`   Pipedrive contacts created: ${formatNumber(pipedriveCreated)}`);
  console.log(`   Estimated completion: ~${estimatedMinutes} minutes`);
  console.log('='.repeat(50) + '\n');

  if (isDryRun) {
    console.log('💡 Run without --dry-run to actually send messages.\n');
  } else {
    console.log('✅ Messages are being delivered by QStash.\n');
    console.log(`📈 Check stats: https://aac-middleware.vercel.app/api/campaign/stats?id=${campaignId}\n`);
  }
}

main().catch((error) => {
  console.error('\n❌ Error:', error.message);
  console.error(error.stack);
  process.exit(1);
});
