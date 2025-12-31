/**
 * Campaign Stats Endpoint
 *
 * Returns campaign statistics and status.
 *
 * Usage:
 *   GET /api/campaign/stats?id=campaign-2025-01-15-braintree
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getCampaign, getActiveCampaigns } from '../../src/lib/redis.js';
import { logger } from '../../src/lib/logger.js';

const log = logger.child({ handler: 'campaign-stats' });

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Only accept GET
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { id } = req.query;

    // If no ID provided, list all active campaigns
    if (!id) {
      const campaigns = await getActiveCampaigns();
      return res.status(200).json({
        success: true,
        campaigns: campaigns.map((c) => ({
          id: c.id,
          name: c.name,
          status: c.status,
          createdAt: c.createdAt,
          stats: c.stats,
        })),
      });
    }

    // Get specific campaign
    const campaign = await getCampaign(id as string);

    if (!campaign) {
      return res.status(404).json({ error: 'Campaign not found' });
    }

    // Calculate response rate
    const responseRate =
      campaign.stats.sent > 0
        ? ((campaign.stats.responses / campaign.stats.sent) * 100).toFixed(1)
        : '0.0';

    log.info('Campaign stats requested', { id, status: campaign.status });

    return res.status(200).json({
      success: true,
      campaign: {
        id: campaign.id,
        name: campaign.name,
        status: campaign.status,
        createdAt: campaign.createdAt,
        messageTemplate: campaign.messageTemplate,
        stats: {
          ...campaign.stats,
          responseRate: `${responseRate}%`,
        },
      },
    });
  } catch (error) {
    log.error('Campaign stats error', error as Error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
