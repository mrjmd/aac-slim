/**
 * QuickBooks OAuth Callback Handler
 *
 * Receives the authorization code from QuickBooks and exchanges it for tokens.
 * Stores tokens in Redis for later use by the QuickBooks client.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getEnv } from '../../../src/lib/env.js';
import { logger } from '../../../src/lib/logger.js';
import { storeQBTokens } from '../../../src/lib/redis.js';

const log = logger.child({ handler: 'quickbooks-oauth-callback' });

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number; // seconds until access token expires (typically 3600 = 1 hour)
  x_refresh_token_expires_in: number; // seconds until refresh token expires (typically 8726400 = 101 days)
  token_type: string;
}

export default async function handler(
  req: VercelRequest,
  res: VercelResponse
): Promise<void> {
  const env = getEnv();

  const { code, state, realmId, error, error_description } = req.query;

  // Check for errors from QuickBooks
  if (error) {
    log.error('OAuth error from QuickBooks', new Error(String(error_description || error)));
    res.status(400).send(`
      <h1>QuickBooks Authorization Failed</h1>
      <p>Error: ${error}</p>
      <p>${error_description || ''}</p>
    `);
    return;
  }

  // Validate state (CSRF protection)
  if (state !== 'aac-middleware') {
    log.warn('Invalid OAuth state', { state });
    res.status(400).send('<h1>Invalid state parameter</h1>');
    return;
  }

  // Validate code
  if (!code || typeof code !== 'string') {
    log.warn('Missing authorization code');
    res.status(400).send('<h1>Missing authorization code</h1>');
    return;
  }

  try {
    // Exchange code for tokens
    const tokenUrl = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';

    const credentials = Buffer.from(
      `${env.quickbooks.clientId}:${env.quickbooks.clientSecret}`
    ).toString('base64');

    const tokenResponse = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Basic ${credentials}`,
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: env.quickbooks.redirectUri,
      }),
    });

    if (!tokenResponse.ok) {
      const errorText = await tokenResponse.text();
      log.error('Token exchange failed', new Error(errorText), {
        status: tokenResponse.status,
      });
      res.status(500).send(`
        <h1>Token Exchange Failed</h1>
        <p>Status: ${tokenResponse.status}</p>
        <pre>${errorText}</pre>
      `);
      return;
    }

    const tokens = (await tokenResponse.json()) as TokenResponse;

    // Calculate expiration timestamps
    const now = Date.now();
    const expiresAt = now + tokens.expires_in * 1000;
    const refreshTokenExpiresAt = now + tokens.x_refresh_token_expires_in * 1000;

    // Store tokens in Redis
    await storeQBTokens({
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt,
      refreshTokenExpiresAt,
    });

    log.info('QuickBooks OAuth tokens stored successfully', {
      expiresIn: tokens.expires_in,
      refreshExpiresIn: tokens.x_refresh_token_expires_in,
    });

    // Check if realmId matches what we have configured
    const realmIdMatch = realmId === env.quickbooks.realmId;

    res.status(200).send(`
      <h1>QuickBooks Connected Successfully!</h1>
      <p>Access token expires in: ${Math.round(tokens.expires_in / 60)} minutes</p>
      <p>Refresh token expires in: ${Math.round(tokens.x_refresh_token_expires_in / 86400)} days</p>
      <p>Realm ID from callback: <strong>${realmId}</strong></p>
      <p>Realm ID in env: <strong>${env.quickbooks.realmId}</strong></p>
      ${!realmIdMatch ? '<p style="color: red;"><strong>WARNING: Realm IDs do not match! Update QUICKBOOKS_REALM_ID env var.</strong></p>' : '<p style="color: green;">Realm IDs match ✓</p>'}
      <p>You can close this window.</p>
    `);
  } catch (error) {
    log.error('OAuth callback error', error as Error);
    res.status(500).send(`
      <h1>Authorization Error</h1>
      <p>An unexpected error occurred. Please try again.</p>
    `);
  }
}
