/**
 * Commission Report Endpoint
 * GET /api/reports/commissions?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
 *
 * Query params:
 * - startDate: Start of date range (required)
 * - endDate: End of date range (required)
 * - format: 'json' | 'html' | 'text' (default: 'html')
 * - sendSms: 'true' to send SMS summary via Quo (default: 'false')
 * - run: 'true' to run attribution before reporting (default: 'false')
 * - reprocess: 'true' to re-run already processed invoices (default: 'false')
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { logger } from '../../src/lib/logger.js';
import { getAttributionsByDateRange } from '../../src/lib/redis.js';
import { runAttribution, isCommissionedSalesRep } from '../../src/lib/attribution.js';
import {
  generateHtmlReport,
  generateTextReport,
  generateSmsSummary,
  generateJsonSummary,
} from '../../src/lib/report-generator.js';
import { sendMessage } from '../../src/clients/quo.js';
import { getEnv } from '../../src/lib/env.js';

const log = logger.child({ endpoint: 'commissions' });

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const {
      startDate,
      endDate,
      format = 'html',
      sendSms = 'false',
      run = 'false',
      reprocess = 'false',
    } = req.query as Record<string, string>;

    // Validate required params
    if (!startDate || !endDate) {
      return res.status(400).json({
        error: 'Missing required parameters',
        required: ['startDate', 'endDate'],
        format: 'YYYY-MM-DD',
        example: '/api/reports/commissions?startDate=2025-12-01&endDate=2025-12-31',
      });
    }

    // Validate date format
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (!dateRegex.test(startDate) || !dateRegex.test(endDate)) {
      return res.status(400).json({
        error: 'Invalid date format',
        expected: 'YYYY-MM-DD',
      });
    }

    log.info('Commission report requested', {
      startDate,
      endDate,
      format,
      sendSms,
      run,
      reprocess,
    });

    // Run attribution if requested
    let runResult = null;
    if (run === 'true') {
      log.info('Running attribution before report');
      runResult = await runAttribution(startDate, endDate, {
        reprocess: reprocess === 'true',
      });
    }

    // Get attribution results from Redis, filter to only commissioned salespeople
    const allResults = await getAttributionsByDateRange(startDate, endDate);
    const results = allResults.filter(r => isCommissionedSalesRep(r.salesRepId));

    log.info('Retrieved attribution results', {
      total: allResults.length,
      commissioned: results.length,
    });

    const reportData = {
      startDate,
      endDate,
      results,
    };

    // Send SMS summary if requested
    if (sendSms === 'true') {
      const env = getEnv();
      const ownerPhone = env.notifications.alertPhoneNumber;
      const fromPhone = env.quo.phoneNumber;
      const smsSummary = generateSmsSummary(reportData);

      log.info('Sending SMS summary', { from: fromPhone, to: ownerPhone, message: smsSummary });

      try {
        await sendMessage(fromPhone, ownerPhone, smsSummary);
        log.info('SMS summary sent');
      } catch (smsError) {
        log.error('Failed to send SMS summary', smsError as Error);
        // Don't fail the request, just log the error
      }
    }

    // Return response based on format
    switch (format) {
      case 'json':
        return res.status(200).json({
          success: true,
          ...(runResult && { attributionRun: runResult }),
          report: generateJsonSummary(reportData),
        });

      case 'text':
        res.setHeader('Content-Type', 'text/plain');
        return res.status(200).send(generateTextReport(reportData));

      case 'html':
      default:
        res.setHeader('Content-Type', 'text/html');
        return res.status(200).send(generateHtmlReport(reportData));
    }
  } catch (error) {
    log.error('Commission report failed', error as Error);
    return res.status(500).json({
      error: 'Failed to generate commission report',
      message: (error as Error).message,
    });
  }
}
