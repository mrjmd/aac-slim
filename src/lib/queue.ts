/**
 * QStash Queue Integration for Campaign Messages
 * Handles delayed message delivery with staggered timing
 */

import { Client } from '@upstash/qstash';
import { getEnv } from '@/lib/env';
import { logger } from '@/lib/logger';

const log = logger.child({ lib: 'queue' });

interface QueuedMessage {
  campaignId: string;
  pipedrivePersonId: number;
  phone: string;
  message: string;
  variant?: string;
}

let qstashClient: Client | null = null;

/**
 * Get or create the QStash client
 */
function getQStashClient(): Client {
  if (qstashClient) return qstashClient;

  const env = getEnv();
  if (!env.qstash.token) {
    throw new Error('QSTASH_TOKEN is required for campaign messaging');
  }

  qstashClient = new Client({ token: env.qstash.token });
  return qstashClient;
}

/**
 * Calculate delay for a message in a batch
 * Staggers messages by 2-3 seconds with random jitter to appear human
 * @param index - Position in the queue (0-based)
 * @returns Delay in seconds
 */
export function calculateDelay(index: number): number {
  // Base delay: 2.5 seconds per message
  const baseDelay = index * 2.5;
  // Add jitter: ±0.5 seconds
  const jitter = (Math.random() - 0.5) * 1;
  return Math.max(0, baseDelay + jitter);
}

/**
 * Queue a single message for delayed delivery via QStash
 * @param payload - Message data including campaign info
 * @param delaySeconds - Delay before delivery
 * @param callbackUrl - URL to call when delivering (e.g., /api/campaign/send)
 */
export async function queueMessage(
  payload: QueuedMessage,
  delaySeconds: number,
  callbackUrl: string
): Promise<{ messageId: string }> {
  const client = getQStashClient();

  log.debug('Queueing message', {
    campaignId: payload.campaignId,
    phone: payload.phone,
    delaySeconds,
  });

  const result = await client.publishJSON({
    url: callbackUrl,
    body: payload,
    delay: Math.round(delaySeconds),
  });

  log.info('Message queued', {
    messageId: result.messageId,
    campaignId: payload.campaignId,
    phone: payload.phone,
    delaySeconds: Math.round(delaySeconds),
  });

  return { messageId: result.messageId };
}

/**
 * Queue multiple messages with staggered delays
 * @param messages - Array of messages to queue
 * @param callbackUrl - URL to call when delivering
 * @returns Array of message IDs
 */
export async function batchQueue(
  messages: QueuedMessage[],
  callbackUrl: string
): Promise<{ messageIds: string[]; totalDelay: number }> {
  const messageIds: string[] = [];
  let lastDelay = 0;

  for (let i = 0; i < messages.length; i++) {
    const delay = calculateDelay(i);
    lastDelay = delay;

    const result = await queueMessage(messages[i], delay, callbackUrl);
    messageIds.push(result.messageId);
  }

  log.info('Batch queued', {
    count: messages.length,
    totalDelaySeconds: Math.round(lastDelay),
    estimatedCompletionMinutes: Math.round(lastDelay / 60),
  });

  return { messageIds, totalDelay: lastDelay };
}

/**
 * Verify a QStash webhook signature
 * Used in /api/campaign/send to verify the request came from QStash
 */
export async function verifyQStashSignature(
  signature: string,
  body: string
): Promise<boolean> {
  const env = getEnv();

  if (!env.qstash.currentSigningKey) {
    log.warn('QSTASH_CURRENT_SIGNING_KEY not set, skipping verification');
    return true; // Allow in development without key
  }

  const { Receiver } = await import('@upstash/qstash');

  const receiver = new Receiver({
    currentSigningKey: env.qstash.currentSigningKey,
    nextSigningKey: env.qstash.nextSigningKey ?? env.qstash.currentSigningKey,
  });

  try {
    await receiver.verify({
      signature,
      body,
    });
    return true;
  } catch {
    log.error('QStash signature verification failed');
    return false;
  }
}
