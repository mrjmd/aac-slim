# Module 1.4: Pipedrive → QuickBooks Customer Sync

## Overview

This module syncs contacts from Pipedrive to QuickBooks Online as Customers:
- **Trigger**: When a contact is added/updated in Pipedrive
- **Action**: Create or link a Customer in QuickBooks with matching info

---

## Prerequisites

### OAuth Connection

QuickBooks requires OAuth authentication before syncing will work.

1. **Visit**: `https://aac-middleware.vercel.app/api/auth/quickbooks/connect`
2. **Authorize** the app in QuickBooks
3. **Verify** you see "QuickBooks Connected Successfully!" with matching Realm IDs

The access token expires every 60 minutes but auto-refreshes. The refresh token expires after 101 days - you'll need to re-authorize if that happens.

### Environment Variables

Ensure these are set in Vercel:
- `QUICKBOOKS_CLIENT_ID`
- `QUICKBOOKS_CLIENT_SECRET`
- `QUICKBOOKS_REALM_ID` (shown in OAuth callback - must match!)
- `QUICKBOOKS_REDIRECT_URI` (`https://aac-middleware.vercel.app/api/auth/quickbooks/callback`)

---

## Test 1.4.1: Pipedrive → QuickBooks (New Contact)

**Goal**: Verify that creating a contact in Pipedrive automatically creates a Customer in QuickBooks.

### Steps

1. **Open Pipedrive** and go to Contacts → People
2. **Create a new person** with:
   - Name: `QB Test User`
   - Phone: `+1 555 123 4567` (or any phone)
   - Email: `qbtest@example.com`
   - Organization: `QB Test Company` (optional)
3. **Wait 5-10 seconds** for webhook to process
4. **Open QuickBooks Online** and go to Sales → Customers
5. **Search for** `QB Test User`

### Expected Results

- [ ] Customer appears in QuickBooks with display name "QB Test User"
- [ ] Email shows `qbtest@example.com`
- [ ] Phone number is populated
- [ ] First name / Last name are properly split

### Cleanup

- Delete the test contact from Pipedrive
- Delete the customer from QuickBooks (Mark as Inactive or delete)

---

## Test 1.4.2: Duplicate Prevention (Email Match)

**Goal**: Verify that if a customer already exists in QuickBooks with the same email, it links rather than creating a duplicate.

### Prerequisites

- Create a customer directly in QuickBooks with email `existing@example.com`

### Steps

1. **In Pipedrive**, create a new person:
   - Name: `Existing Email Test`
   - Email: `existing@example.com` (same as QB customer)
   - Phone: `+1 555 999 8888`
2. **Wait 5-10 seconds**
3. **Check QuickBooks**

### Expected Results

- [ ] No new customer created (still just one customer with that email)
- [ ] The mapping is stored in Redis (check logs)

### Cleanup

- Delete from Pipedrive
- Delete from QuickBooks

---

## Test 1.4.3: Duplicate Prevention (Name Match)

**Goal**: Verify that if a customer already exists with the same display name, it links rather than duplicating.

### Prerequisites

- Create a customer directly in QuickBooks named `Name Match Test`

### Steps

1. **In Pipedrive**, create a new person:
   - Name: `Name Match Test` (exact match)
   - Phone: `+1 555 111 2222`
   - No email
2. **Wait 5-10 seconds**
3. **Check QuickBooks**

### Expected Results

- [ ] No new customer created
- [ ] Existing customer is linked

### Cleanup

- Delete from both systems

---

## Test 1.4.4: ZoomInfo Export Flow

**Goal**: Verify the real-world flow of exporting contacts from ZoomInfo to Pipedrive, then syncing to QuickBooks.

### Steps

1. **In ZoomInfo**, find a contact to export
2. **Export to Pipedrive** (using ZoomInfo's integration)
3. **Wait 10-15 seconds** for both webhooks to process
4. **Check Quo/OpenPhone** - contact should appear
5. **Check QuickBooks** - customer should appear

### Expected Results

- [ ] Contact appears in Pipedrive (from ZoomInfo)
- [ ] Contact syncs to Quo with proper name/company
- [ ] Customer created in QuickBooks with matching info
- [ ] All three systems show consistent data

---

## Test 1.4.5: OAuth Token Refresh

**Goal**: Verify that access tokens auto-refresh when expired.

### Note

This test requires waiting 60+ minutes, so it's more of a monitoring check.

### Steps

1. **Connect QuickBooks** via OAuth
2. **Wait 65+ minutes** (past the 60-minute token expiry)
3. **Trigger a sync** by creating a contact in Pipedrive
4. **Check logs** for token refresh activity

### Expected Results

- [ ] Logs show "Refreshing QuickBooks access token"
- [ ] Sync completes successfully despite expired access token
- [ ] No re-authorization required

---

## Test 1.4.6: QuickBooks Disconnected Handling

**Goal**: Verify graceful handling when QuickBooks is not connected.

### Steps

1. **Clear QuickBooks tokens** from Redis (or use a fresh deployment)
2. **Create a contact in Pipedrive**
3. **Check logs**

### Expected Results

- [ ] Quo sync still works
- [ ] QuickBooks sync is skipped (not errored)
- [ ] Logs show "QuickBooks not connected, skipping sync"

---

## Troubleshooting

### Customer not appearing in QuickBooks

1. Check Vercel logs: `npx vercel logs https://aac-middleware.vercel.app --follow`
2. Verify OAuth is connected: visit `/api/auth/quickbooks/connect`
3. Confirm Realm ID matches between callback and env var
4. Check for "QuickBooks sync failed" errors in logs

### 401 Unauthorized errors

1. Realm ID mismatch - compare callback realmId vs `QUICKBOOKS_REALM_ID` env var
2. Token expired and refresh failed - re-authorize via OAuth
3. Trailing newlines in env vars - remove and re-add with `printf '%s' 'value'`

### "QuickBooks not connected" but OAuth succeeded

1. Tokens might not be stored correctly in Redis
2. Check Redis has `oauth:quickbooks:tokens` key
3. Verify Upstash Redis credentials are correct

### Duplicate customers created

1. Check if email/name search is working
2. Verify the existing customer has the exact same DisplayName or email
3. QuickBooks search is case-sensitive for some fields

---

## Verifying Data in QuickBooks

To check customer details in QuickBooks:

1. Go to **Sales → Customers**
2. Search by name or click on the customer
3. Click **Edit** to see all fields:
   - Display name
   - First/Last name
   - Email
   - Phone
   - Company name
