/**
 * Check if a mapping exists
 * GET /api/admin/check-mapping?qbId=XXX
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getPipedriveIdFromQb, getQbCustomerIdFromPipedrive } from '../../src/lib/redis.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
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
