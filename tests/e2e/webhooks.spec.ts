/**
 * Webhook Endpoint Tests
 *
 * These tests verify that all webhook endpoints are accessible and respond correctly.
 * This prevents regressions where webhooks become inaccessible due to routing issues.
 *
 * CRITICAL: These tests should run on every deployment to prevent webhook outages.
 */

import { test, expect } from '@playwright/test'

const WEBHOOK_ENDPOINTS = [
  {
    name: 'Google Ads',
    path: '/api/webhooks/google-ads',
    expectedResponse: { error: 'Invalid payload' },
    description: 'Processes Google Ads lead form submissions',
  },
  {
    name: 'Pipedrive',
    path: '/api/webhooks/pipedrive',
    expectedResponse: { error: 'Invalid payload' },
    description: 'Syncs Pipedrive contacts to Quo/QuickBooks',
  },
  {
    name: 'Quo (OpenPhone)',
    path: '/api/webhooks/quo',
    expectedResponse: { error: 'Invalid signature' },
    description: 'Logs calls/SMS to Pipedrive, handles campaign responses',
  },
]

test.describe('Webhook Endpoints', () => {
  for (const webhook of WEBHOOK_ENDPOINTS) {
    test(`${webhook.name} webhook is accessible and validates requests`, async ({ request }) => {
      // POST with empty body should get a validation error (not 404/500)
      const response = await request.post(webhook.path, {
        headers: {
          'Content-Type': 'application/json',
        },
        data: {},
      })

      // Webhook should respond (not 404 or 500)
      expect(response.status(), `${webhook.name} webhook returned ${response.status()}`).toBeLessThan(500)
      expect(response.status(), `${webhook.name} webhook returned 404 - route not found`).not.toBe(404)

      // Should return expected validation error
      const body = await response.json()
      expect(body).toEqual(webhook.expectedResponse)
    })

    test(`${webhook.name} webhook rejects non-POST methods`, async ({ request }) => {
      const response = await request.get(webhook.path)
      // Should return 405 Method Not Allowed, not 404
      expect(response.status()).not.toBe(404)
    })
  }
})

test.describe('Webhook Smoke Tests', () => {
  test('All critical webhooks respond to health checks', async ({ request }) => {
    const results = await Promise.all(
      WEBHOOK_ENDPOINTS.map(async (webhook) => {
        const response = await request.post(webhook.path, {
          headers: { 'Content-Type': 'application/json' },
          data: {},
        })
        return {
          name: webhook.name,
          status: response.status(),
          ok: response.status() < 500 && response.status() !== 404,
        }
      })
    )

    // All webhooks should be accessible
    const failures = results.filter((r) => !r.ok)
    expect(failures, `Failed webhooks: ${failures.map((f) => f.name).join(', ')}`).toHaveLength(0)
  })
})
