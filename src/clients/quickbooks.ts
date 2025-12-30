/**
 * QuickBooks Online API client
 * Handles OAuth token refresh and customer CRUD operations
 */

import { getEnv } from '../lib/env.js';
import { logger } from '../lib/logger.js';
import { getQBTokens, storeQBTokens, type QBOAuthTokens } from '../lib/redis.js';

const log = logger.child({ client: 'quickbooks' });

const QBO_API_BASE = 'https://quickbooks.api.intuit.com/v3/company';

// QuickBooks Customer entity
export interface QBCustomer {
  Id?: string;
  DisplayName: string;
  GivenName?: string;
  FamilyName?: string;
  CompanyName?: string;
  PrimaryPhone?: {
    FreeFormNumber: string;
  };
  PrimaryEmailAddr?: {
    Address: string;
  };
  BillAddr?: {
    Line1?: string;
    City?: string;
    CountrySubDivisionCode?: string; // State
    PostalCode?: string;
  };
  Active?: boolean;
}

interface QBResponse<T> {
  QueryResponse?: {
    Customer?: T[];
    Invoice?: T[];
    maxResults?: number;
  };
  Customer?: T;
  Invoice?: T;
}

// QuickBooks Invoice entity
export interface QBInvoice {
  Id: string;
  DocNumber?: string; // Invoice number
  TxnDate?: string; // Transaction date (YYYY-MM-DD)
  DueDate?: string;
  TotalAmt: number;
  Balance: number; // 0 = fully paid
  CustomerRef: {
    value: string; // Customer ID
    name?: string;
  };
  LinkedTxn?: Array<{
    TxnId: string;
    TxnType: string; // "Payment" for payments
  }>;
  MetaData?: {
    CreateTime: string;
    LastUpdatedTime: string;
  };
}

/**
 * Refresh the access token using the refresh token
 */
async function refreshAccessToken(tokens: QBOAuthTokens): Promise<QBOAuthTokens> {
  const env = getEnv();

  log.info('Refreshing QuickBooks access token');

  const credentials = Buffer.from(
    `${env.quickbooks.clientId}:${env.quickbooks.clientSecret}`
  ).toString('base64');

  const response = await fetch('https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer', {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': `Basic ${credentials}`,
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: tokens.refreshToken,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    log.error('Token refresh failed', new Error(error), { status: response.status });
    throw new Error(`QuickBooks token refresh failed: ${response.status}`);
  }

  const data = await response.json();

  const now = Date.now();
  const newTokens: QBOAuthTokens = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: now + data.expires_in * 1000,
    refreshTokenExpiresAt: now + data.x_refresh_token_expires_in * 1000,
  };

  await storeQBTokens(newTokens);
  log.info('QuickBooks tokens refreshed and stored');

  return newTokens;
}

/**
 * Get a valid access token, refreshing if necessary
 */
async function getValidAccessToken(): Promise<string> {
  const tokens = await getQBTokens();

  if (!tokens) {
    throw new Error('QuickBooks not connected. Visit /api/auth/quickbooks/connect to authorize.');
  }

  // Check if access token is expired (with 5 minute buffer)
  const now = Date.now();
  const bufferMs = 5 * 60 * 1000;

  if (tokens.expiresAt - bufferMs < now) {
    // Check if refresh token is also expired
    if (tokens.refreshTokenExpiresAt < now) {
      throw new Error('QuickBooks refresh token expired. Visit /api/auth/quickbooks/connect to re-authorize.');
    }

    const newTokens = await refreshAccessToken(tokens);
    return newTokens.accessToken;
  }

  return tokens.accessToken;
}

/**
 * Make an authenticated request to QuickBooks API
 */
async function qbRequest<T>(
  endpoint: string,
  options: RequestInit = {}
): Promise<T> {
  const env = getEnv();
  const accessToken = await getValidAccessToken();

  const url = `${QBO_API_BASE}/${env.quickbooks.realmId}${endpoint}`;

  const response = await fetch(url, {
    ...options,
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${accessToken}`,
      ...options.headers,
    },
  });

  if (!response.ok) {
    const error = await response.text();
    log.error('QuickBooks API error', new Error(error), {
      endpoint,
      status: response.status,
    });
    throw new Error(`QuickBooks API error: ${response.status} - ${error}`);
  }

  return response.json();
}

/**
 * Search for a customer by email
 */
export async function searchCustomerByEmail(email: string): Promise<QBCustomer | null> {
  try {
    // QuickBooks query syntax - need to escape single quotes
    const escapedEmail = email.replace(/'/g, "\\'");
    const query = `SELECT * FROM Customer WHERE PrimaryEmailAddr = '${escapedEmail}'`;

    const result = await qbRequest<QBResponse<QBCustomer>>(
      `/query?query=${encodeURIComponent(query)}`
    );

    if (result.QueryResponse?.Customer && result.QueryResponse.Customer.length > 0) {
      log.debug('Found customer by email', { email, customerId: result.QueryResponse.Customer[0].Id });
      return result.QueryResponse.Customer[0];
    }

    return null;
  } catch (error) {
    log.error('Search customer by email failed', error as Error, { email });
    throw error;
  }
}

/**
 * Search for a customer by phone number
 */
export async function searchCustomerByPhone(phone: string): Promise<QBCustomer | null> {
  try {
    // QuickBooks doesn't support LIKE on phone, so we search by exact match
    // Phone format matching can be tricky - QB stores phones in various formats
    const query = `SELECT * FROM Customer WHERE PrimaryPhone = '${phone}'`;

    const result = await qbRequest<QBResponse<QBCustomer>>(
      `/query?query=${encodeURIComponent(query)}`
    );

    if (result.QueryResponse?.Customer && result.QueryResponse.Customer.length > 0) {
      log.debug('Found customer by phone', { phone, customerId: result.QueryResponse.Customer[0].Id });
      return result.QueryResponse.Customer[0];
    }

    return null;
  } catch (error) {
    log.error('Search customer by phone failed', error as Error, { phone });
    throw error;
  }
}

/**
 * Search for a customer by display name
 */
export async function searchCustomerByName(displayName: string): Promise<QBCustomer | null> {
  try {
    const escapedName = displayName.replace(/'/g, "\\'");
    const query = `SELECT * FROM Customer WHERE DisplayName = '${escapedName}'`;

    const result = await qbRequest<QBResponse<QBCustomer>>(
      `/query?query=${encodeURIComponent(query)}`
    );

    if (result.QueryResponse?.Customer && result.QueryResponse.Customer.length > 0) {
      log.debug('Found customer by name', { displayName, customerId: result.QueryResponse.Customer[0].Id });
      return result.QueryResponse.Customer[0];
    }

    return null;
  } catch (error) {
    log.error('Search customer by name failed', error as Error, { displayName });
    throw error;
  }
}

/**
 * Create a new customer in QuickBooks
 */
export async function createCustomer(customer: {
  displayName: string;
  firstName?: string;
  lastName?: string;
  companyName?: string;
  email?: string;
  phone?: string;
}): Promise<QBCustomer> {
  log.info('Creating QuickBooks customer', { displayName: customer.displayName });

  const body: QBCustomer = {
    DisplayName: customer.displayName,
  };

  if (customer.firstName) body.GivenName = customer.firstName;
  if (customer.lastName) body.FamilyName = customer.lastName;
  if (customer.companyName) body.CompanyName = customer.companyName;

  if (customer.email) {
    body.PrimaryEmailAddr = { Address: customer.email };
  }

  if (customer.phone) {
    body.PrimaryPhone = { FreeFormNumber: customer.phone };
  }

  const result = await qbRequest<QBResponse<QBCustomer>>('/customer', {
    method: 'POST',
    body: JSON.stringify(body),
  });

  if (!result.Customer) {
    throw new Error('QuickBooks did not return customer after creation');
  }

  log.info('Created QuickBooks customer', {
    customerId: result.Customer.Id,
    displayName: customer.displayName,
  });

  return result.Customer;
}

/**
 * Update an existing customer in QuickBooks
 * Note: QuickBooks requires the SyncToken for updates (optimistic locking)
 */
export async function updateCustomer(
  customerId: string,
  updates: Partial<QBCustomer> & { SyncToken: string }
): Promise<QBCustomer> {
  log.info('Updating QuickBooks customer', { customerId });

  const body = {
    Id: customerId,
    ...updates,
  };

  const result = await qbRequest<QBResponse<QBCustomer>>('/customer', {
    method: 'POST', // QuickBooks uses POST for updates too
    body: JSON.stringify(body),
  });

  if (!result.Customer) {
    throw new Error('QuickBooks did not return customer after update');
  }

  log.info('Updated QuickBooks customer', { customerId });

  return result.Customer;
}

/**
 * Get a customer by ID
 */
export async function getCustomer(customerId: string): Promise<QBCustomer | null> {
  try {
    const result = await qbRequest<QBResponse<QBCustomer>>(`/customer/${customerId}`);
    return result.Customer || null;
  } catch (error) {
    log.error('Get customer failed', error as Error, { customerId });
    return null;
  }
}

/**
 * Check if QuickBooks is connected (has valid tokens)
 */
export async function isQuickBooksConnected(): Promise<boolean> {
  try {
    await getValidAccessToken();
    return true;
  } catch {
    return false;
  }
}

// ============================================
// INVOICE FUNCTIONS (for Attribution Engine)
// ============================================

/**
 * Get paid invoices within a date range
 * Paid invoices have Balance = 0
 */
export async function getPaidInvoices(
  startDate: string, // YYYY-MM-DD
  endDate: string    // YYYY-MM-DD
): Promise<QBInvoice[]> {
  try {
    // Query for invoices with Balance = 0 (fully paid) within date range
    // TxnDate is the invoice date, but we want to filter by when it was paid
    // We'll use MetaData.LastUpdatedTime as a proxy (paid invoices get updated when paid)
    const query = `SELECT * FROM Invoice WHERE Balance = '0' AND TxnDate >= '${startDate}' AND TxnDate <= '${endDate}' ORDERBY TxnDate DESC MAXRESULTS 1000`;

    log.info('Fetching paid invoices', { startDate, endDate });

    const result = await qbRequest<QBResponse<QBInvoice>>(
      `/query?query=${encodeURIComponent(query)}`
    );

    const invoices = result.QueryResponse?.Invoice || [];

    log.info('Found paid invoices', { count: invoices.length, startDate, endDate });

    return invoices;
  } catch (error) {
    log.error('Get paid invoices failed', error as Error, { startDate, endDate });
    throw error;
  }
}

/**
 * Get a single invoice by ID
 */
export async function getInvoice(invoiceId: string): Promise<QBInvoice | null> {
  try {
    const result = await qbRequest<{ Invoice: QBInvoice }>(`/invoice/${invoiceId}`);
    return result.Invoice || null;
  } catch (error) {
    log.error('Get invoice failed', error as Error, { invoiceId });
    return null;
  }
}
