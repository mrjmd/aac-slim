/**
 * Manually create a QB ↔ Pipedrive mapping
 * POST /api/admin/create-mapping?qbId=XXX&pipedriveId=YYY
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { logger } from '../../src/lib/logger.js';
import {
  storePipedriveToQbMapping,
  storeQbToPipedriveMapping,
} from '../../src/lib/redis.js';

const log = logger.child({ endpoint: 'create-mapping' });

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed. Use POST.' });
  }

  try {
    const { qbId, pipedriveId } = req.query as Record<string, string>;

    if (!qbId || !pipedriveId) {
      return res.status(400).json({
        error: 'Missing required parameters',
        required: ['qbId', 'pipedriveId'],
        example: '/api/admin/create-mapping?qbId=123&pipedriveId=456',
      });
    }

    log.info('Creating manual mapping', { qbId, pipedriveId });

    // Store bidirectional mapping
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
  } catch (error) {
    log.error('Create mapping failed', error as Error);
    return res.status(500).json({
      error: 'Create mapping failed',
      message: (error as Error).message,
    });
  }
}
