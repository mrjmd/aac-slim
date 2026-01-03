/**
 * Attribution Engine
 * Traces referral chains and calculates sales commissions
 */

import { logger } from '@/lib/logger';
import {
  getPipedriveIdFromQb,
  storeAttribution,
  wasInvoiceAttributed,
  type AttributionResult,
} from '@/lib/redis';
import {
  getPerson,
  getPersonReferredBy,
  getPipedriveUser,
} from '@/clients/pipedrive';
import { getPaidInvoices, type QBInvoice } from '@/clients/quickbooks';

const log = logger.child({ module: 'attribution' });

// Commission configuration
// Only salespeople in this list earn commissions
// If owner is not in this list, no commission is owed (e.g., owner-closed deals)
const COMMISSION_RATES: Record<number, { name: string; rate: number }> = {
  24313124: { name: 'Edward Crowell', rate: 0.20 },
};

// Maximum chain depth to prevent infinite loops
const MAX_CHAIN_DEPTH = 10;

interface TraversalResult {
  salesRepId: number;
  salesRepName: string;
  chain: number[]; // Person IDs in the chain
}

/**
 * Traverse the referral chain to find the salesperson
 * Goes up the "Referred by" chain until reaching a person with no referrer
 * Then returns that person's owner (the salesperson)
 */
async function traverseReferralChain(
  startPersonId: number
): Promise<TraversalResult | null> {
  const chain: number[] = [];
  let currentPersonId = startPersonId;
  const visited = new Set<number>();

  for (let depth = 0; depth < MAX_CHAIN_DEPTH; depth++) {
    // Circular reference detection
    if (visited.has(currentPersonId)) {
      log.warn('Circular reference detected in referral chain', {
        startPersonId,
        chain,
        circularAt: currentPersonId,
      });
      break;
    }
    visited.add(currentPersonId);
    chain.push(currentPersonId);

    // Check if this person was referred by someone
    const referredById = await getPersonReferredBy(currentPersonId);

    if (referredById) {
      // Continue up the chain
      currentPersonId = referredById;
    } else {
      // End of chain - this person's owner is the salesperson
      break;
    }
  }

  // Get the owner of the last person in the chain
  const topPerson = await getPerson(chain[chain.length - 1]);
  if (!topPerson || !topPerson.owner_id?.id) {
    log.warn('Could not find owner for top of chain', {
      startPersonId,
      chain,
      topPersonId: chain[chain.length - 1],
    });
    return null;
  }

  // Get the salesperson's details
  const salesRep = await getPipedriveUser(topPerson.owner_id.id);
  if (!salesRep) {
    log.warn('Could not find salesperson user', {
      ownerId: topPerson.owner_id,
      chain,
    });
    return null;
  }

  return {
    salesRepId: salesRep.id,
    salesRepName: salesRep.name,
    chain,
  };
}

/**
 * Check if a salesperson earns commission
 */
export function isCommissionedSalesRep(salesRepId: number): boolean {
  return salesRepId in COMMISSION_RATES;
}

/**
 * Get commission rate for a salesperson
 * Returns 0 if not a commissioned salesperson
 */
function getCommissionRate(salesRepId: number): number {
  const config = COMMISSION_RATES[salesRepId];
  return config?.rate ?? 0;
}

/**
 * Process a single invoice and create attribution
 */
async function processInvoice(invoice: QBInvoice): Promise<AttributionResult | null> {
  const invoiceId = invoice.Id;
  const invoiceNumber = invoice.DocNumber || invoiceId;

  // Skip already processed invoices
  if (await wasInvoiceAttributed(invoiceId)) {
    log.debug('Invoice already attributed', { invoiceId, invoiceNumber });
    return null;
  }

  // Get customer info from invoice
  const customerId = invoice.CustomerRef.value;
  const customerName = invoice.CustomerRef.name || 'Unknown';

  // Look up Pipedrive Person ID from QB Customer ID
  const pipedrivePersonId = await getPipedriveIdFromQb(customerId);

  if (!pipedrivePersonId) {
    log.warn('No Pipedrive mapping for QB customer', {
      invoiceId,
      invoiceNumber,
      qbCustomerId: customerId,
      customerName,
    });
    return null;
  }

  // Traverse the referral chain
  const traversalResult = await traverseReferralChain(parseInt(pipedrivePersonId, 10));

  if (!traversalResult) {
    log.warn('Could not traverse referral chain', {
      invoiceId,
      invoiceNumber,
      pipedrivePersonId,
    });
    return null;
  }

  // Skip if owner is not a commissioned salesperson (e.g., owner-closed deals)
  if (!isCommissionedSalesRep(traversalResult.salesRepId)) {
    log.debug('Owner is not a commissioned salesperson, skipping', {
      invoiceId,
      invoiceNumber,
      salesRepId: traversalResult.salesRepId,
      salesRepName: traversalResult.salesRepName,
    });
    return null;
  }

  // Calculate commission
  const commissionRate = getCommissionRate(traversalResult.salesRepId);
  const commissionAmount = Math.round(invoice.TotalAmt * commissionRate * 100) / 100;

  const result: AttributionResult = {
    invoiceId,
    invoiceNumber,
    customerId,
    customerName,
    invoiceAmount: invoice.TotalAmt,
    invoiceDate: invoice.TxnDate || new Date().toISOString().split('T')[0],
    salesRepId: traversalResult.salesRepId,
    salesRepName: traversalResult.salesRepName,
    commissionRate,
    commissionAmount,
    attributedAt: new Date().toISOString(),
    referralChain: traversalResult.chain,
  };

  // Store the attribution
  await storeAttribution(result);

  log.info('Attribution created', {
    invoiceId,
    invoiceNumber,
    customerName,
    amount: invoice.TotalAmt,
    salesRep: traversalResult.salesRepName,
    commission: commissionAmount,
  });

  return result;
}

export interface AttributionRunResult {
  processed: number;
  attributed: number;
  skipped: number;
  errors: number;
  results: AttributionResult[];
  unattributed: Array<{
    invoiceId: string;
    invoiceNumber: string;
    customerId: string;
    customerName: string;
    amount: number;
    reason: string;
  }>;
}

/**
 * Run attribution for a date range
 * Fetches paid invoices from QuickBooks and creates attributions
 */
export async function runAttribution(
  startDate: string,
  endDate: string,
  options?: {
    reprocess?: boolean; // Re-process already attributed invoices
  }
): Promise<AttributionRunResult> {
  log.info('Starting attribution run', { startDate, endDate, options });

  const result: AttributionRunResult = {
    processed: 0,
    attributed: 0,
    skipped: 0,
    errors: 0,
    results: [],
    unattributed: [],
  };

  try {
    // Fetch paid invoices from QuickBooks
    const invoices = await getPaidInvoices(startDate, endDate);
    log.info('Fetched paid invoices', { count: invoices.length });

    for (const invoice of invoices) {
      result.processed++;

      try {
        // Check if already processed (unless reprocessing)
        if (!options?.reprocess && await wasInvoiceAttributed(invoice.Id)) {
          result.skipped++;
          continue;
        }

        const attribution = await processInvoice(invoice);

        if (attribution) {
          result.attributed++;
          result.results.push(attribution);
        } else {
          result.unattributed.push({
            invoiceId: invoice.Id,
            invoiceNumber: invoice.DocNumber || invoice.Id,
            customerId: invoice.CustomerRef.value,
            customerName: invoice.CustomerRef.name || 'Unknown',
            amount: invoice.TotalAmt,
            reason: 'No Pipedrive mapping or referral chain',
          });
        }
      } catch (error) {
        result.errors++;
        log.error('Error processing invoice', error as Error, {
          invoiceId: invoice.Id,
        });
      }
    }

    log.info('Attribution run complete', {
      processed: result.processed,
      attributed: result.attributed,
      skipped: result.skipped,
      errors: result.errors,
    });

    return result;
  } catch (error) {
    log.error('Attribution run failed', error as Error);
    throw error;
  }
}
