/**
 * Report Generator for Attribution Engine
 * Creates HTML tables and SMS summaries from attribution data
 */

import { type AttributionResult } from './redis.js';

interface ReportData {
  startDate: string;
  endDate: string;
  results: AttributionResult[];
}

interface SalesRepSummary {
  salesRepId: number;
  salesRepName: string;
  invoiceCount: number;
  totalInvoiceAmount: number;
  totalCommission: number;
  commissionRate: number;
}

/**
 * Group attribution results by sales rep
 */
function groupBySalesRep(results: AttributionResult[]): Map<number, AttributionResult[]> {
  const grouped = new Map<number, AttributionResult[]>();

  for (const result of results) {
    const existing = grouped.get(result.salesRepId) || [];
    existing.push(result);
    grouped.set(result.salesRepId, existing);
  }

  return grouped;
}

/**
 * Calculate summary for each sales rep
 */
function calculateSummaries(results: AttributionResult[]): SalesRepSummary[] {
  const grouped = groupBySalesRep(results);
  const summaries: SalesRepSummary[] = [];

  for (const [salesRepId, items] of grouped) {
    const totalInvoiceAmount = items.reduce((sum, r) => sum + r.invoiceAmount, 0);
    const totalCommission = items.reduce((sum, r) => sum + r.commissionAmount, 0);

    summaries.push({
      salesRepId,
      salesRepName: items[0].salesRepName,
      invoiceCount: items.length,
      totalInvoiceAmount: Math.round(totalInvoiceAmount * 100) / 100,
      totalCommission: Math.round(totalCommission * 100) / 100,
      commissionRate: items[0].commissionRate,
    });
  }

  // Sort by name
  summaries.sort((a, b) => a.salesRepName.localeCompare(b.salesRepName));

  return summaries;
}

/**
 * Format currency for display
 */
function formatCurrency(amount: number): string {
  return `$${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * Format date range for display
 */
function formatDateRange(startDate: string, endDate: string): string {
  const start = new Date(startDate);
  const end = new Date(endDate);

  const options: Intl.DateTimeFormatOptions = {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  };

  return `${start.toLocaleDateString('en-US', options)} - ${end.toLocaleDateString('en-US', options)}`;
}

/**
 * Generate HTML table report (copy-paste ready for email)
 */
export function generateHtmlReport(data: ReportData): string {
  const { startDate, endDate, results } = data;
  const summaries = calculateSummaries(results);
  const dateRange = formatDateRange(startDate, endDate);

  if (results.length === 0) {
    return `
<div style="font-family: Arial, sans-serif; max-width: 800px; margin: 0 auto;">
  <h2 style="color: #333;">AAC Commission Report</h2>
  <p><strong>Period:</strong> ${dateRange}</p>
  <p style="color: #666; font-style: italic;">No commissions owed in this period.</p>
</div>
    `.trim();
  }

  let html = `
<div style="font-family: Arial, sans-serif; max-width: 800px; margin: 0 auto;">
  <h2 style="color: #333;">AAC Commission Report</h2>
  <p><strong>Period:</strong> ${dateRange}</p>
`;

  // Generate section for each sales rep
  for (const summary of summaries) {
    const repResults = results.filter(r => r.salesRepId === summary.salesRepId);

    html += `
  <h3 style="color: #444; margin-top: 24px; border-bottom: 2px solid #4CAF50; padding-bottom: 4px;">
    ${summary.salesRepName}
  </h3>
  <p style="color: #666; margin: 4px 0;">Commission Rate: ${(summary.commissionRate * 100).toFixed(0)}%</p>

  <table style="width: 100%; border-collapse: collapse; margin: 16px 0;">
    <thead>
      <tr style="background-color: #f5f5f5;">
        <th style="text-align: left; padding: 8px; border: 1px solid #ddd;">Invoice #</th>
        <th style="text-align: left; padding: 8px; border: 1px solid #ddd;">Customer</th>
        <th style="text-align: left; padding: 8px; border: 1px solid #ddd;">Date</th>
        <th style="text-align: right; padding: 8px; border: 1px solid #ddd;">Amount</th>
        <th style="text-align: right; padding: 8px; border: 1px solid #ddd;">Commission</th>
      </tr>
    </thead>
    <tbody>`;

    for (const result of repResults) {
      html += `
      <tr>
        <td style="padding: 8px; border: 1px solid #ddd;">${result.invoiceNumber}</td>
        <td style="padding: 8px; border: 1px solid #ddd;">${result.customerName}</td>
        <td style="padding: 8px; border: 1px solid #ddd;">${result.invoiceDate}</td>
        <td style="text-align: right; padding: 8px; border: 1px solid #ddd;">${formatCurrency(result.invoiceAmount)}</td>
        <td style="text-align: right; padding: 8px; border: 1px solid #ddd;">${formatCurrency(result.commissionAmount)}</td>
      </tr>`;
    }

    html += `
      <tr style="background-color: #e8f5e9; font-weight: bold;">
        <td colspan="3" style="padding: 8px; border: 1px solid #ddd;">TOTAL</td>
        <td style="text-align: right; padding: 8px; border: 1px solid #ddd;">${formatCurrency(summary.totalInvoiceAmount)}</td>
        <td style="text-align: right; padding: 8px; border: 1px solid #ddd;">${formatCurrency(summary.totalCommission)}</td>
      </tr>
    </tbody>
  </table>
`;
  }

  // Grand total if multiple sales reps
  if (summaries.length > 1) {
    const grandTotalInvoices = summaries.reduce((sum, s) => sum + s.totalInvoiceAmount, 0);
    const grandTotalCommission = summaries.reduce((sum, s) => sum + s.totalCommission, 0);

    html += `
  <h3 style="color: #333; margin-top: 24px;">Grand Total</h3>
  <table style="width: 100%; border-collapse: collapse; margin: 16px 0;">
    <tr style="background-color: #4CAF50; color: white; font-weight: bold;">
      <td style="padding: 12px; border: 1px solid #ddd;">Total Invoice Amount</td>
      <td style="text-align: right; padding: 12px; border: 1px solid #ddd;">${formatCurrency(grandTotalInvoices)}</td>
    </tr>
    <tr style="background-color: #4CAF50; color: white; font-weight: bold;">
      <td style="padding: 12px; border: 1px solid #ddd;">Total Commission</td>
      <td style="text-align: right; padding: 12px; border: 1px solid #ddd;">${formatCurrency(grandTotalCommission)}</td>
    </tr>
  </table>
`;
  }

  html += `
  <p style="color: #999; font-size: 12px; margin-top: 24px;">
    Generated: ${new Date().toLocaleString('en-US')}
  </p>
</div>`;

  return html.trim();
}

/**
 * Generate plain text table (for CLI output or plain text email)
 */
export function generateTextReport(data: ReportData): string {
  const { startDate, endDate, results } = data;
  const summaries = calculateSummaries(results);
  const dateRange = formatDateRange(startDate, endDate);

  if (results.length === 0) {
    return `AAC Commission Report\nPeriod: ${dateRange}\n\nNo commissions owed in this period.`;
  }

  let text = `AAC Commission Report\nPeriod: ${dateRange}\n`;

  for (const summary of summaries) {
    const repResults = results.filter(r => r.salesRepId === summary.salesRepId);

    text += `\n${'='.repeat(60)}\nSales Rep: ${summary.salesRepName}\n`;
    text += `Commission Rate: ${(summary.commissionRate * 100).toFixed(0)}%\n`;
    text += `${'-'.repeat(60)}\n`;
    text += `Invoice #     | Customer              | Date       | Amount     | Commission\n`;
    text += `${'-'.repeat(60)}\n`;

    for (const result of repResults) {
      const inv = result.invoiceNumber.padEnd(13);
      const cust = result.customerName.substring(0, 20).padEnd(21);
      const date = result.invoiceDate;
      const amt = formatCurrency(result.invoiceAmount).padStart(10);
      const comm = formatCurrency(result.commissionAmount).padStart(10);
      text += `${inv} | ${cust} | ${date} | ${amt} | ${comm}\n`;
    }

    text += `${'-'.repeat(60)}\n`;
    text += `TOTAL                                     | ${formatCurrency(summary.totalInvoiceAmount).padStart(10)} | ${formatCurrency(summary.totalCommission).padStart(10)}\n`;
  }

  return text.trim();
}

/**
 * Generate SMS summary for Quo
 * Keep under 160 chars for single SMS
 */
export function generateSmsSummary(data: ReportData): string {
  const { startDate, results } = data;
  const summaries = calculateSummaries(results);

  if (results.length === 0) {
    const month = new Date(startDate).toLocaleDateString('en-US', { month: 'short' });
    return `${month} commissions: No commissions owed.`;
  }

  // Build compact summary
  const parts: string[] = [];

  for (const summary of summaries) {
    // Use first name only to save space
    const firstName = summary.salesRepName.split(' ')[0];
    parts.push(`${firstName} $${Math.round(summary.totalCommission).toLocaleString()} (${summary.invoiceCount} jobs)`);
  }

  // Get month name from start date
  const month = new Date(startDate).toLocaleDateString('en-US', { month: 'short' });

  return `${month} commissions: ${parts.join(', ')}`;
}

/**
 * Generate JSON summary for API response
 */
export function generateJsonSummary(data: ReportData): {
  period: { startDate: string; endDate: string };
  summaries: SalesRepSummary[];
  totalInvoiceCount: number;
  totalInvoiceAmount: number;
  totalCommission: number;
  results: AttributionResult[];
} {
  const summaries = calculateSummaries(data.results);

  return {
    period: {
      startDate: data.startDate,
      endDate: data.endDate,
    },
    summaries,
    totalInvoiceCount: data.results.length,
    totalInvoiceAmount: summaries.reduce((sum, s) => sum + s.totalInvoiceAmount, 0),
    totalCommission: summaries.reduce((sum, s) => sum + s.totalCommission, 0),
    results: data.results,
  };
}
