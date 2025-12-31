/**
 * Consolidated Admin Endpoint
 *
 * Actions:
 *   - POST ?action=create-mapping&qbId=XXX&pipedriveId=YYY - Create a QB↔PD mapping
 *   - POST ?action=backfill&startDate=YYYY-MM-DD&endDate=YYYY-MM-DD - Backfill mappings
 *   - GET  ?action=check&qbId=XXX or ?action=check&pipedriveId=YYY - Check mapping
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { logger } from '../../src/lib/logger.js';
import {
  storePipedriveToQbMapping,
  storeQbToPipedriveMapping,
  getPipedriveIdFromQb,
  getQbCustomerIdFromPipedrive,
} from '../../src/lib/redis.js';
import { getPaidInvoices } from '../../src/clients/quickbooks.js';

const log = logger.child({ endpoint: 'admin' });

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const { action } = req.query as Record<string, string>;

  if (!action) {
    return res.status(400).json({
      error: 'Missing action parameter',
      availableActions: ['create-mapping', 'backfill', 'check'],
    });
  }

  try {
    switch (action) {
      case 'create-mapping':
        return handleCreateMapping(req, res);
      case 'backfill':
        return handleBackfill(req, res);
      case 'check':
        return handleCheck(req, res);
      default:
        return res.status(400).json({
          error: `Unknown action: ${action}`,
          availableActions: ['create-mapping', 'backfill', 'check'],
        });
    }
  } catch (error) {
    log.error('Admin action failed', error as Error, { action });
    return res.status(500).json({
      error: 'Action failed',
      message: (error as Error).message,
    });
  }
}

async function handleCreateMapping(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed. Use POST.' });
  }

  const { qbId, pipedriveId } = req.query as Record<string, string>;

  if (!qbId || !pipedriveId) {
    return res.status(400).json({
      error: 'Missing required parameters',
      required: ['qbId', 'pipedriveId'],
      example: '/api/admin?action=create-mapping&qbId=123&pipedriveId=456',
    });
  }

  log.info('Creating manual mapping', { qbId, pipedriveId });

  await storePipedriveToQbMapping(pipedriveId, qbId);
  await storeQbToPipedriveMapping(qbId, pipedriveId);

  log.info('Mapping created', { qbId, pipedriveId });

  return res.status(200).json({
    success: true,
    mapping: {
      quickbooksCustomerId: qbId,
      pipedrivePersonId: pipedriveId,
    },
  });
}

async function handleBackfill(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed. Use POST.' });
  }

  const { startDate, endDate } = req.query as Record<string, string>;

  if (!startDate || !endDate) {
    return res.status(400).json({
      error: 'Missing required parameters',
      required: ['startDate', 'endDate'],
      example: '/api/admin?action=backfill&startDate=2025-12-01&endDate=2025-12-31',
    });
  }

  log.info('Starting mapping backfill', { startDate, endDate });

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

    const existingPdId = await getPipedriveIdFromQb(qbCustomerId);
    if (existingPdId) {
      results.alreadyMapped++;
      continue;
    }

    log.info('Customer needs mapping', { qbCustomerId, customerName });
    results.notFound.push({ qbId: qbCustomerId, name: customerName });
  }

  log.info('Backfill complete', results);

  return res.status(200).json({
    success: true,
    results,
    message: results.notFound.length > 0
      ? 'Some customers need manual mapping. Use ?action=create-mapping to map them.'
      : 'All customers already mapped!',
  });
}

async function handleCheck(req: VercelRequest, res: VercelResponse) {
  const { qbId, pipedriveId } = req.query as Record<string, string>;

  const result: Record<string, unknown> = {};

  if (qbId) {
    result.qbToPipedrive = await getPipedriveIdFromQb(qbId);
  }

  if (pipedriveId) {
    result.pipedriveToQb = await getQbCustomerIdFromPipedrive(pipedriveId);
  }

  return res.status(200).json(result);
}
