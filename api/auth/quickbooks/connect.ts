/**
 * QuickBooks OAuth Connection Initiation
 *
 * Visit this endpoint to start the OAuth flow.
 * You'll be redirected to QuickBooks to authorize, then back to /callback
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getEnv } from '../../../src/lib/env.js';

export default async function handler(
  _req: VercelRequest,
  res: VercelResponse
): Promise<void> {
  const env = getEnv();

  // QuickBooks OAuth authorization URL
  const authUrl = new URL('https://appcenter.intuit.com/connect/oauth2');

  authUrl.searchParams.set('client_id', env.quickbooks.clientId);
  authUrl.searchParams.set('redirect_uri', env.quickbooks.redirectUri);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', 'com.intuit.quickbooks.accounting');
  authUrl.searchParams.set('state', 'aac-middleware'); // Simple state for CSRF protection

  // Redirect to QuickBooks authorization page
  res.redirect(302, authUrl.toString());
}
