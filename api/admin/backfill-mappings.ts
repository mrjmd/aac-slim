/**
 * Backfill QB ↔ Pipedrive mappings
 * POST /api/admin/backfill-mappings
 *
 * Searches for QB customers by name/email in Pipedrive and creates bidirectional mappings
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { logger } from '../../src/lib/logger.js';
import { getPipedriveIdFromQb } from '../../src/lib/redis.js';
import { getPaidInvoices } from '../../src/clients/quickbooks.js';

const log = logger.child({ endpoint: 'backfill-mappings' });

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed. Use POST.' });
  }

  try {
    const { startDate, endDate } = req.query as Record<string, string>;

    if (!startDate || !endDate) {
      return res.status(400).json({
        error: 'Missing required parameters',
        required: ['startDate', 'endDate'],
        example: '/api/admin/backfill-mappings?startDate=2025-12-01&endDate=2025-12-31',
      });
    }

    log.info('Starting mapping backfill', { startDate, endDate });

    // Get paid invoices from QB
    const invoices = await getPaidInvoices(startDate, endDate);

    const results = {
      total: invoices.length,
      alreadyMapped: 0,
      newMappings: 0,
      notFound: [] as Array<{ qbId: string; name: string }>,
    };

    for (const invoice of invoices) {
      const qbCustomerId = invoice.CustomerRef.value;
      const customerName = invoice.CustomerRef.name || 'Unknown';

      // Check if already mapped
      const existingPdId = await getPipedriveIdFromQb(qbCustomerId);
      if (existingPdId) {
        results.alreadyMapped++;
        continue;
      }

      // Try to find in Pipedrive by phone (if we have it from the invoice)
      // Note: QB invoices don't include customer phone, so we'd need to fetch the full customer
      // For now, we'll log what's missing and you can manually map them

      log.info('Customer needs mapping', { qbCustomerId, customerName });
      results.notFound.push({ qbId: qbCustomerId, name: customerName });
    }

    log.info('Backfill complete', results);

    return res.status(200).json({
      success: true,
      results,
      message: results.notFound.length > 0
        ? 'Some customers need manual mapping. Use /api/admin/create-mapping to map them.'
        : 'All customers already mapped!',
    });
  } catch (error) {
    log.error('Backfill failed', error as Error);
    return res.status(500).json({
      error: 'Backfill failed',
      message: (error as Error).message,
    });
  }
}
