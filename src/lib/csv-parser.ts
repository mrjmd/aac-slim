/**
 * Property Radar CSV Parser
 * Parses and normalizes homeowner data from Property Radar exports
 */

import { parse } from 'csv-parse/sync';
import { logger } from './logger.js';

const log = logger.child({ lib: 'csv-parser' });

/**
 * Raw row from Property Radar CSV
 */
interface PropertyRadarRow {
  'Primary Name'?: string;
  'Primary Mobile Phone1'?: string;
  'Primary Mobile 1 Status'?: string;
  'City'?: string;
  'Subdivision'?: string;
  'Address'?: string;
  'ZIP'?: string;
  'Est Value'?: string;
  'Est Equity $'?: string;
  'Yr Built'?: string;
  'Primary Email1'?: string;
  'Secondary Name'?: string;
  'Secondary Mobile Phone1'?: string;
  [key: string]: string | undefined;
}

/**
 * Normalized contact ready for campaign processing
 */
export interface NormalizedContact {
  firstName: string;
  lastName: string | null;
  phone: string; // E.164 format
  email: string | null;
  city: string;
  subdivision: string | null;
  address: string | null;
  zip: string | null;
  estValue: number | null;
  estEquity: number | null;
  yearBuilt: number | null;
  isPrimary: boolean; // false if this is a secondary contact
  propertyAddress: string; // For linking secondary to primary
}

/**
 * Parse result with stats
 */
export interface ParseResult {
  contacts: NormalizedContact[];
  stats: {
    totalRows: number;
    primaryContacts: number;
    secondaryContacts: number;
    skippedNoPhone: number;
    skippedInactivePhone: number;
    skippedInvalidPhone: number;
  };
}

/**
 * Normalize a name from "JON LINKER" to { firstName: "Jon", lastName: "Linker" }
 */
export function normalizeName(fullName: string): { firstName: string; lastName: string | null } {
  if (!fullName || !fullName.trim()) {
    return { firstName: 'Homeowner', lastName: null };
  }

  const parts = fullName.trim().split(/\s+/);

  if (parts.length === 0) {
    return { firstName: 'Homeowner', lastName: null };
  }

  // Title case each part
  const titleCase = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();

  if (parts.length === 1) {
    return { firstName: titleCase(parts[0]), lastName: null };
  }

  return {
    firstName: titleCase(parts[0]),
    lastName: parts.slice(1).map(titleCase).join(' '),
  };
}

/**
 * Normalize a phone number to E.164 format
 * Input: "339-222-4624" or "(339) 222-4624" or "3392224624"
 * Output: "+13392224624"
 */
export function normalizePhone(phone: string): string | null {
  if (!phone) return null;

  // Remove all non-digit characters
  const digits = phone.replace(/\D/g, '');

  // Handle different lengths
  if (digits.length === 10) {
    // US number without country code
    return `+1${digits}`;
  } else if (digits.length === 11 && digits.startsWith('1')) {
    // US number with country code
    return `+${digits}`;
  } else if (digits.length > 10 && digits.length <= 15) {
    // International number, assume it has country code
    return `+${digits}`;
  }

  // Invalid phone number
  return null;
}

/**
 * Parse a Property Radar CSV string into normalized contacts
 */
export function parsePropertyRadarCSV(csvContent: string): ParseResult {
  const stats = {
    totalRows: 0,
    primaryContacts: 0,
    secondaryContacts: 0,
    skippedNoPhone: 0,
    skippedInactivePhone: 0,
    skippedInvalidPhone: 0,
  };

  const contacts: NormalizedContact[] = [];

  // Parse CSV
  const rows = parse(csvContent, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  }) as PropertyRadarRow[];

  stats.totalRows = rows.length;

  for (const row of rows) {
    const propertyAddress = `${row['Address'] || ''}, ${row['City'] || ''} ${row['ZIP'] || ''}`.trim();

    // Process primary contact
    const primaryPhone = row['Primary Mobile Phone1'];
    const primaryStatus = row['Primary Mobile 1 Status'];

    if (!primaryPhone) {
      stats.skippedNoPhone++;
    } else if (primaryStatus && primaryStatus.toLowerCase() !== 'active') {
      stats.skippedInactivePhone++;
    } else {
      const normalizedPhone = normalizePhone(primaryPhone);
      if (!normalizedPhone) {
        stats.skippedInvalidPhone++;
        log.debug('Invalid phone format', { phone: primaryPhone });
      } else {
        const { firstName, lastName } = normalizeName(row['Primary Name'] || '');

        contacts.push({
          firstName,
          lastName,
          phone: normalizedPhone,
          email: row['Primary Email1'] || null,
          city: row['City'] || 'Unknown',
          subdivision: row['Subdivision'] !== row['City'] ? row['Subdivision'] || null : null,
          address: row['Address'] || null,
          zip: row['ZIP'] || null,
          estValue: row['Est Value'] ? parseInt(row['Est Value'], 10) : null,
          estEquity: row['Est Equity $'] ? parseInt(row['Est Equity $'], 10) : null,
          yearBuilt: row['Yr Built'] ? parseInt(row['Yr Built'], 10) : null,
          isPrimary: true,
          propertyAddress,
        });
        stats.primaryContacts++;
      }
    }

    // Process secondary contact (if present)
    const secondaryPhone = row['Secondary Mobile Phone1'];
    if (secondaryPhone) {
      const normalizedPhone = normalizePhone(secondaryPhone);
      if (normalizedPhone) {
        const { firstName, lastName } = normalizeName(row['Secondary Name'] || '');

        contacts.push({
          firstName,
          lastName,
          phone: normalizedPhone,
          email: null, // Secondary contacts don't have email in CSV
          city: row['City'] || 'Unknown',
          subdivision: row['Subdivision'] !== row['City'] ? row['Subdivision'] || null : null,
          address: row['Address'] || null,
          zip: row['ZIP'] || null,
          estValue: row['Est Value'] ? parseInt(row['Est Value'], 10) : null,
          estEquity: row['Est Equity $'] ? parseInt(row['Est Equity $'], 10) : null,
          yearBuilt: row['Yr Built'] ? parseInt(row['Yr Built'], 10) : null,
          isPrimary: false,
          propertyAddress,
        });
        stats.secondaryContacts++;
      }
    }
  }

  log.info('Parsed CSV', {
    totalRows: stats.totalRows,
    contacts: contacts.length,
    primary: stats.primaryContacts,
    secondary: stats.secondaryContacts,
    skippedNoPhone: stats.skippedNoPhone,
    skippedInactive: stats.skippedInactivePhone,
    skippedInvalid: stats.skippedInvalidPhone,
  });

  return { contacts, stats };
}

/**
 * Parse a CSV file from disk
 */
export async function parsePropertyRadarFile(filePath: string): Promise<ParseResult> {
  const fs = await import('fs/promises');
  const content = await fs.readFile(filePath, 'utf-8');
  return parsePropertyRadarCSV(content);
}
