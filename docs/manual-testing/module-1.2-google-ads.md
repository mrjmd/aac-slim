# Module 1.2: Google Ads Lead Form Integration

## Overview

This module receives leads from Google Ads Lead Form Extensions and:
1. Creates or updates Pipedrive contacts
2. Sends SMS alerts for new leads
3. Creates follow-up tasks in Pipedrive

---

## Test 1.2.1: Google Ads Test Lead

**Goal**: Verify the Google Ads webhook processes test leads correctly.

### Prerequisites

- Google Ads Lead Form configured with webhook URL
- `GOOGLE_ADS_WEBHOOK_KEY` set in Vercel

### Steps

1. **In Google Ads**, go to your Lead Form asset
2. **Expand** "Export leads from Google Ads" → "Other data integration options"
3. **Under Webhook integration**, click "Send test data"
4. **Wait 5-10 seconds**
5. **Check Pipedrive** for new contact
6. **Check your phone** for SMS alert

### Expected Results

- [ ] Pipedrive contact created with test data (name like "Test Lead")
- [ ] Phone number stored correctly
- [ ] Note attached with campaign ID, form ID
- [ ] Task created: "🔥 Google Ads Lead - Call [Name]"
- [ ] SMS received with lead details (prefixed with [TEST])

### Notes

- Test leads use `is_test: true` flag and skip deduplication
- Same test lead can be sent multiple times

---

## Test 1.2.2: Lead with Existing Contact

**Goal**: Verify that leads from known phone numbers update existing contacts.

### Prerequisites

- An existing Pipedrive contact with a known phone number

### Steps

1. **Note the phone number** of an existing Pipedrive contact
2. **Use curl to simulate a lead** with that phone number:

```bash
curl -X POST https://aac-middleware.vercel.app/api/webhooks/google-ads \
  -H "Content-Type: application/json" \
  -d '{
    "lead_id": "test-existing-'$(date +%s)'",
    "user_column_data": [
      {"column_id": "FULL_NAME", "string_value": "Updated Lead Name"},
      {"column_id": "PHONE_NUMBER", "string_value": "+1XXXXXXXXXX"},
      {"column_id": "EMAIL", "string_value": "updated@example.com"}
    ],
    "form_id": 12345,
    "campaign_id": 67890,
    "google_key": "YOUR_WEBHOOK_KEY",
    "is_test": true
  }'
```

3. **Check Pipedrive** for the existing contact

### Expected Results

- [ ] No duplicate contact created
- [ ] If contact was "Unknown Lead", name updated
- [ ] Task still created for follow-up
- [ ] SMS alert received

---

## Test 1.2.3: Invalid Webhook Key

**Goal**: Verify unauthorized requests are rejected.

### Steps

1. **Send a request with wrong key**:

```bash
curl -X POST https://aac-middleware.vercel.app/api/webhooks/google-ads \
  -H "Content-Type: application/json" \
  -d '{
    "lead_id": "test-invalid-key",
    "user_column_data": [
      {"column_id": "FULL_NAME", "string_value": "Bad Actor"},
      {"column_id": "PHONE_NUMBER", "string_value": "+15551234567"}
    ],
    "form_id": 12345,
    "campaign_id": 67890,
    "google_key": "wrong-key"
  }'
```

### Expected Results

- [ ] Response: `401 Unauthorized` with `{"error": "Invalid google_key"}`
- [ ] No contact created in Pipedrive
- [ ] No SMS sent

---

## Test 1.2.4: Deduplication

**Goal**: Verify the same lead isn't processed twice.

### Steps

1. **Send a lead** (non-test):

```bash
curl -X POST https://aac-middleware.vercel.app/api/webhooks/google-ads \
  -H "Content-Type: application/json" \
  -d '{
    "lead_id": "dedupe-test-123",
    "user_column_data": [
      {"column_id": "FULL_NAME", "string_value": "Dedupe Test"},
      {"column_id": "PHONE_NUMBER", "string_value": "+15559876543"}
    ],
    "form_id": 12345,
    "campaign_id": 67890,
    "google_key": "YOUR_WEBHOOK_KEY"
  }'
```

2. **Send the exact same request again** (same `lead_id`)

### Expected Results

- [ ] First request: `{"status": "processed", ...}`
- [ ] Second request: `{"status": "ignored", "reason": "duplicate"}`
- [ ] Only one contact created
- [ ] Only one SMS received

### Cleanup

- Delete test contact from Pipedrive

---

## Test 1.2.5: Missing Phone Number

**Goal**: Verify leads without phone numbers are handled gracefully.

### Steps

1. **Send a lead without phone**:

```bash
curl -X POST https://aac-middleware.vercel.app/api/webhooks/google-ads \
  -H "Content-Type: application/json" \
  -d '{
    "lead_id": "no-phone-test",
    "user_column_data": [
      {"column_id": "FULL_NAME", "string_value": "No Phone Lead"},
      {"column_id": "EMAIL", "string_value": "nophone@example.com"}
    ],
    "form_id": 12345,
    "campaign_id": 67890,
    "google_key": "YOUR_WEBHOOK_KEY",
    "is_test": true
  }'
```

### Expected Results

- [ ] Response: `{"status": "skipped", "reason": "no_phone"}`
- [ ] No contact created (we require phone for our workflow)
- [ ] No SMS sent
- [ ] No errors in logs

---

## Troubleshooting

### No SMS received

1. Verify `ALERT_PHONE_NUMBER` is set correctly in Vercel
2. Verify `QUO_PHONE_NUMBER` is set (sender number)
3. Check Vercel logs for Quo API errors
4. Confirm Quo account has SMS sending capability

### Task not created

1. Check Vercel logs for Pipedrive API errors
2. Verify Pipedrive API key has permission to create activities

### "Invalid google_key" on valid requests

1. Check for trailing whitespace/newlines in the Vercel env var
2. Re-add using: `printf '%s' 'your-key' | npx vercel env add GOOGLE_ADS_WEBHOOK_KEY production`
