/**
 * Campaign Stats Endpoint
 *
 * Returns campaign statistics and status, including A/B test variant analysis.
 *
 * Usage:
 *   GET /api/campaign/stats?id=campaign-2025-01-15-braintree
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getCampaign, getActiveCampaigns, type CampaignVariant } from '../../src/lib/redis.js';
import { logger } from '../../src/lib/logger.js';

const log = logger.child({ handler: 'campaign-stats' });

/**
 * Calculate response rate as a percentage
 */
function calcResponseRate(responses: number, sent: number): string {
  return sent > 0 ? ((responses / sent) * 100).toFixed(1) : '0.0';
}

/**
 * Analyze A/B test results and determine winner
 */
function analyzeVariants(variants: CampaignVariant[]): {
  variants: Array<{
    id: string;
    message: string;
    sent: number;
    responses: number;
    optOuts: number;
    responseRate: string;
  }>;
  insights: string[];
} {
  const analyzed = variants.map((v) => ({
    id: v.id,
    message: v.message.substring(0, 50) + (v.message.length > 50 ? '...' : ''),
    sent: v.stats.sent,
    responses: v.stats.responses,
    optOuts: v.stats.optOuts,
    responseRate: `${calcResponseRate(v.stats.responses, v.stats.sent)}%`,
  }));

  const insights: string[] = [];

  // Need at least 10 sends per variant for meaningful analysis
  const sufficientData = variants.every((v) => v.stats.sent >= 10);

  if (!sufficientData) {
    insights.push('Collecting more data for statistical significance...');
  } else {
    // Compare response rates
    const rates = variants.map((v) => ({
      id: v.id,
      rate: v.stats.sent > 0 ? v.stats.responses / v.stats.sent : 0,
    }));

    rates.sort((a, b) => b.rate - a.rate);

    if (rates.length >= 2 && rates[0].rate > 0) {
      const winner = rates[0];
      const runnerUp = rates[1];

      if (runnerUp.rate > 0) {
        const improvement = ((winner.rate - runnerUp.rate) / runnerUp.rate) * 100;

        if (improvement >= 20) {
          insights.push(`Variant ${winner.id} is performing ${improvement.toFixed(0)}% better than ${runnerUp.id}`);
        } else if (improvement >= 5) {
          insights.push(`Variant ${winner.id} has a slight edge over ${runnerUp.id}`);
        } else {
          insights.push('Both variants are performing similarly');
        }
      } else {
        insights.push(`Variant ${winner.id} is the only one with responses so far`);
      }
    }

    // Check opt-out rates
    const optOutRates = variants.map((v) => ({
      id: v.id,
      rate: v.stats.sent > 0 ? v.stats.optOuts / v.stats.sent : 0,
    }));

    const highOptOut = optOutRates.find((v) => v.rate > 0.05);
    if (highOptOut) {
      insights.push(`Warning: Variant ${highOptOut.id} has a high opt-out rate (${(highOptOut.rate * 100).toFixed(1)}%)`);
    }
  }

  return { variants: analyzed, insights };
}

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
          hasVariants: !!c.variants,
          stats: c.stats,
        })),
      });
    }

    // Get specific campaign
    const campaign = await getCampaign(id as string);

    if (!campaign) {
      return res.status(404).json({ error: 'Campaign not found' });
    }

    // Calculate overall response rate
    const responseRate = calcResponseRate(campaign.stats.responses, campaign.stats.sent);

    log.info('Campaign stats requested', { id, status: campaign.status });

    // Build response
    const response: Record<string, unknown> = {
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
    };

    // Add A/B test analysis if variants exist
    if (campaign.variants && campaign.variants.length > 0) {
      const analysis = analyzeVariants(campaign.variants);
      (response.campaign as Record<string, unknown>).abTest = {
        variants: analysis.variants,
        insights: analysis.insights,
      };
    }

    return res.status(200).json(response);
  } catch (error) {
    log.error('Campaign stats error', error as Error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
