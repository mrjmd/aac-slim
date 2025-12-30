# Manual Testing Guide

This directory contains step-by-step manual testing procedures for each module of the AAC Middleware.

## Modules

| Module | Description | Test File |
|--------|-------------|-----------|
| 1.1 | Pipedrive ↔ Quo Bidirectional Sync | [module-1.1-sync.md](./module-1.1-sync.md) |
| 1.2 | Google Ads Lead Form Integration | [module-1.2-google-ads.md](./module-1.2-google-ads.md) |
| 1.3 | AI Listener (Entity Extraction) | [module-1.3-ai-listener.md](./module-1.3-ai-listener.md) |
| 1.4 | Pipedrive → QuickBooks Sync | [module-1.4-quickbooks.md](./module-1.4-quickbooks.md) |
| 2.0 | Attribution Engine & Commission Reports | [module-2-attribution.md](./module-2-attribution.md) |

## Prerequisites

Before testing, ensure:

1. **Environment is deployed**: `npx vercel --prod`
2. **Environment variables are set** in Vercel:
   - `PIPEDRIVE_API_KEY`
   - `PIPEDRIVE_COMPANY_DOMAIN`
   - `PIPEDRIVE_SYSTEM_USER_ID`
   - `QUO_API_KEY`
   - `QUO_WEBHOOK_SECRET`
   - `QUO_PHONE_NUMBER`
   - `GOOGLE_ADS_WEBHOOK_KEY`
   - `GEMINI_API_KEY`
   - `ALERT_PHONE_NUMBER`
   - `UPSTASH_REDIS_REST_URL`
   - `UPSTASH_REDIS_REST_TOKEN`
   - `QUICKBOOKS_CLIENT_ID`
   - `QUICKBOOKS_CLIENT_SECRET`
   - `QUICKBOOKS_REALM_ID`
   - `QUICKBOOKS_REDIRECT_URI`

3. **Webhooks are configured**:
   - Pipedrive webhook pointing to `https://aac-middleware.vercel.app/api/webhooks/pipedrive`
   - Quo/OpenPhone webhook pointing to `https://aac-middleware.vercel.app/api/webhooks/quo`
   - Google Ads lead form webhook pointing to `https://aac-middleware.vercel.app/api/webhooks/google-ads`

## Viewing Logs

To view logs for debugging:

```bash
npx vercel logs https://aac-middleware.vercel.app --follow
```

## Test Phone Numbers

Use a personal phone not already in either system for clean testing. Before each test session, you may want to delete any test contacts created in previous sessions.
