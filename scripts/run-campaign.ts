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
 *
 * A/B Testing:
 *   npx tsx scripts/run-campaign.ts \
 *     --csv="Export-20250115.csv" \
 *     --name="2025-01-15-Braintree" \
 *     --message-a="Hi {firstName}, we're doing work in {city}..." \
 *     --message-b="Hey {firstName}! Noticed you're in {city}..."
 */

// Load .env file
import { config } from 'dotenv';
config();

import { parseArgs } from 'node:util';
import { parsePropertyRadarFile, type NormalizedContact } from '../src/lib/csv-parser.js';
import { hasExistingConversation } from '../src/clients/quo.js';
import { createCampaignContact } from '../src/clients/pipedrive.js';
import {
  createCampaign,
  incrementCampaignStats,
  updateCampaignStatus,
  selectVariant,
  type CampaignVariant,
} from '../src/lib/redis.js';
import { queueMessage, calculateDelay } from '../src/lib/queue.js';
import { getEnv } from '../src/lib/env.js';

// Parse CLI arguments
const { values } = parseArgs({
  options: {
    csv: { type: 'string', short: 'c' },
    name: { type: 'string', short: 'n' },
    message: { type: 'string', short: 'm' },
    'message-a': { type: 'string' },
    'message-b': { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
    'skip-dedup': { type: 'boolean', default: false },
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
  --message, -m   Message template with {firstName} and {city} placeholders
  --message-a     Variant A message (for A/B testing)
  --message-b     Variant B message (for A/B testing)
  --dry-run       Process CSV but don't queue messages or create contacts
  --skip-dedup    Skip Quo conversation history check (for testing)
  --help, -h      Show this help

Either --message OR both --message-a and --message-b are required.

Examples:
  # Single message campaign:
  npx tsx scripts/run-campaign.ts \\
    --csv="exports/Export-20250115.csv" \\
    --name="2025-01-15-Braintree" \\
    --message="Hi {firstName}, I noticed you're a homeowner in {city}..."

  # A/B test campaign (50/50 split):
  npx tsx scripts/run-campaign.ts \\
    --csv="exports/Export-20250115.csv" \\
    --name="2025-01-15-Braintree-AB" \\
    --message-a="Hi {firstName}, we're doing work in {city}..." \\
    --message-b="Hey {firstName}! Noticed you're in {city}..."
`);
}

if (values.help) {
  printHelp();
  process.exit(0);
}

// Validate required args
const hasMessage = !!values.message;
const hasABTest = !!values['message-a'] && !!values['message-b'];

if (!values.csv || !values.name) {
  console.error('Error: --csv and --name are required\n');
  printHelp();
  process.exit(1);
}

if (!hasMessage && !hasABTest) {
  console.error('Error: Either --message OR both --message-a and --message-b are required\n');
  printHelp();
  process.exit(1);
}

if (hasMessage && hasABTest) {
  console.error('Error: Cannot use --message with --message-a/--message-b. Choose one approach.\n');
  printHelp();
  process.exit(1);
}

const isDryRun = values['dry-run'];
const skipDedup = values['skip-dedup'];
const isABTest = hasABTest;

// Build variants array if A/B testing
const variants: Array<{ id: string; message: string; weight: number }> | undefined = isABTest
  ? [
      { id: 'A', message: values['message-a']!, weight: 50 },
      { id: 'B', message: values['message-b']!, weight: 50 },
    ]
  : undefined;

/**
 * Normalize to title case: "QUINCY" -> "Quincy", "south boston" -> "South Boston"
 */
function toTitleCase(str: string): string {
  if (!str) return '';
  return str
    .toLowerCase()
    .split(' ')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/**
 * Personalize a message template with contact data
 */
function personalizeMessage(template: string, contact: NormalizedContact): string {
  return template
    .replace(/\{firstName\}/g, toTitleCase(contact.firstName))
    .replace(/\{lastName\}/g, toTitleCase(contact.lastName || ''))
    .replace(/\{city\}/g, toTitleCase(contact.city))
    .replace(/\{neighborhood\}/g, toTitleCase(contact.subdivision || contact.city));
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

  if (isABTest) {
    console.log(`🧪 A/B TEST MODE - 50/50 split between variants A and B`);
  }
  if (isDryRun) {
    console.log('⚠️  DRY RUN MODE - No messages will be sent\n');
  }
  if (skipDedup) {
    console.log('⚠️  SKIP DEDUP MODE - Will not check for existing conversations\n');
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
  const defaultMessage = values.message || values['message-a']!; // Fallback for display

  if (!isDryRun) {
    await createCampaign(campaignId, values.name!, defaultMessage, variants);
    await incrementCampaignStats(campaignId, { total: contacts.length });
  }

  console.log(`🎯 Campaign ID: ${campaignId}\n`);

  // For A/B test tracking
  const variantCounts: Record<string, number> = { A: 0, B: 0 };

  // Build the callback URL for QStash
  const callbackUrl = `${process.env.VERCEL_URL || 'https://aac-middleware.vercel.app'}/api/campaign/send`;

  // Process contacts
  if (!skipDedup) {
    console.log('🔍 Checking Quo for existing conversations...\n');
  } else {
    console.log('🔍 Processing contacts (dedup disabled)...\n');
  }

  let queued = 0;
  let skipped = 0;
  let pipedriveCreated = 0;
  let queueIndex = 0;

  for (let i = 0; i < contacts.length; i++) {
    const contact = contacts[i];
    const progress = `[${i + 1}/${contacts.length}]`;

    // Check if we've already messaged this person via Quo (unless --skip-dedup)
    if (!skipDedup) {
      const hasConversation = await hasExistingConversation(contact.phone);

      if (hasConversation) {
        console.log(`${progress} ⏭️  ${contact.phone} - Already contacted, skipping`);
        skipped++;

        if (!isDryRun) {
          await incrementCampaignStats(campaignId, { skipped: 1 });
        }
        continue;
      }
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

    // Select message (variant if A/B testing, otherwise single message)
    let messageTemplate: string;
    let variantId: string | undefined;

    if (isABTest && variants) {
      // Use weighted random selection for A/B test
      const selectedVariant = selectVariant(variants as CampaignVariant[]);
      messageTemplate = selectedVariant.message;
      variantId = selectedVariant.id;
      variantCounts[variantId]++;
    } else {
      messageTemplate = values.message!;
    }

    // Personalize the message
    const personalizedMessage = personalizeMessage(messageTemplate, contact);

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
          variant: variantId,
        },
        delay,
        callbackUrl
      );
      await incrementCampaignStats(campaignId, { queued: 1 });
    }

    const variantLabel = variantId ? ` [${variantId}]` : '';
    console.log(`${progress} ✅ ${contact.phone} - ${contact.firstName} in ${contact.city}${variantLabel}`);
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
  if (isABTest) {
    console.log(`      → Variant A: ${formatNumber(variantCounts.A)}`);
    console.log(`      → Variant B: ${formatNumber(variantCounts.B)}`);
  }
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
