# Module 3: Campaign Manager - Manual Testing Plan

**Last Updated:** December 31, 2024

This document provides step-by-step manual testing procedures for the Campaign Manager module.

---

## Prerequisites

1. Local `.env` file configured with all required variables
2. Access to Pipedrive admin
3. Access to Quo/OpenPhone dashboard
4. Access to Vercel deployment
5. Sample Property Radar CSV export

---

## Test 1: CSV Parsing & Validation

### Objective
Verify CSV parsing correctly handles Property Radar exports.

### Steps

1. Create a test CSV with known data:
```csv
Primary Name,Primary Mobile Phone1,Primary Mobile 1 Status,City,Subdivision,Address,ZIP,Primary Email1,Secondary Name,Secondary Mobile Phone1
JON LINKER,339-222-4624,Active,BRAINTREE,BRAINTREE,455 MIDDLE ST,02184,jon@example.com,AIMEE LINKER,781-316-1658
```

2. Run dry-run:
```bash
npx tsx scripts/run-campaign.ts \
  --csv="test.csv" \
  --name="Test-Parsing" \
  --message="Test message" \
  --dry-run
```

### Expected Results
- [ ] Name parsed correctly: "Jon" (not "JON")
- [ ] Phone normalized to E.164: "+13392224624"
- [ ] Primary and secondary contacts both extracted
- [ ] Stats show correct counts

### Edge Cases to Test
- [ ] Missing phone number (should skip)
- [ ] Inactive phone status (should skip)
- [ ] Invalid phone format (should skip)
- [ ] Missing name (should default to "Homeowner")
- [ ] Rows with inconsistent column counts (should handle gracefully)

---

## Test 2: Quo Deduplication

### Objective
Verify contacts with existing Quo conversation history are skipped.

### Steps

1. Identify a phone number with existing message history in Quo
2. Add that number to your test CSV
3. Run dry-run:
```bash
npx tsx scripts/run-campaign.ts \
  --csv="test.csv" \
  --name="Test-Dedup" \
  --message="Test message" \
  --dry-run
```

### Expected Results
- [ ] Contact with existing history shows "Already contacted, skipping"
- [ ] Skipped count increments correctly
- [ ] New contacts proceed normally

---

## Test 3: Pipedrive Contact Creation

### Objective
Verify contacts are created in Pipedrive before texting.

### Steps

1. Use test phone numbers not in Pipedrive
2. Run campaign (non-dry-run, use --skip-dedup for internal numbers):
```bash
npx tsx scripts/run-campaign.ts \
  --csv="test.csv" \
  --name="Test-Pipedrive" \
  --message="Test message" \
  --skip-dedup
```

3. Check Pipedrive for new contacts

### Expected Results
- [ ] Contact created with correct name (title case)
- [ ] Phone number in E.164 format
- [ ] Email populated if in CSV
- [ ] Address fields populated
- [ ] Lead source set to campaign-related value

---

## Test 4: Message Queuing & Delivery

### Objective
Verify messages are queued to QStash and delivered via Quo.

### Steps

1. Run campaign with internal test numbers:
```bash
npx tsx scripts/run-campaign.ts \
  --csv="internal-test.csv" \
  --name="Test-Delivery" \
  --message="Hi {firstName}, this is a test for {city}." \
  --skip-dedup
```

2. Check QStash dashboard for queued messages
3. Wait for delivery (check delays in output)
4. Verify messages received on test phones

### Expected Results
- [ ] Messages appear in QStash queue
- [ ] Delays are staggered (0s, ~2.5s, ~5s, etc.)
- [ ] Messages delivered to phones
- [ ] Campaign stats updated (sent count)

---

## Test 5: A/B Testing

### Objective
Verify A/B variant selection and tracking.

### Steps

1. Run A/B test campaign:
```bash
npx tsx scripts/run-campaign.ts \
  --csv="test.csv" \
  --name="Test-AB" \
  --message-a="Version A: Hi {firstName}..." \
  --message-b="Version B: Hey {firstName}..." \
  --skip-dedup
```

2. Check console output for variant assignments
3. Check stats endpoint

### Expected Results
- [ ] Console shows [A] or [B] for each contact
- [ ] Roughly 50/50 split over many contacts
- [ ] Stats endpoint shows variant breakdown:
```bash
curl https://aac-middleware.vercel.app/api/campaign/stats?id=campaign-test-ab
```

---

## Test 6: Response Tracking

### Objective
Verify inbound messages from campaign contacts are tracked.

### Steps

1. Run a campaign to a test phone
2. Reply from that phone
3. Check campaign stats

### Expected Results
- [ ] Response count increments
- [ ] If A/B test, variant-specific response increments
- [ ] Pipedrive activity logged (existing Module 1.1 behavior)

---

## Test 7: Opt-Out Detection

### Objective
Verify opt-out keywords are detected and handled.

### Steps

1. Run a campaign to a test phone
2. Reply with "STOP" from that phone
3. Check campaign stats and opt-out list

### Expected Results
- [ ] Opt-out count increments
- [ ] Phone added to global opt-out list
- [ ] Subsequent campaigns skip this phone

### Keywords to Test
- [ ] STOP
- [ ] CANCEL
- [ ] UNSUBSCRIBE
- [ ] QUIT
- [ ] END
- [ ] Case variations (stop, Stop, STOP)

---

## Test 8: Stats Endpoint

### Objective
Verify stats endpoint returns correct data.

### Steps

1. Run a campaign
2. Query stats:
```bash
# Specific campaign
curl https://aac-middleware.vercel.app/api/campaign/stats?id=campaign-xxx

# All active campaigns
curl https://aac-middleware.vercel.app/api/campaign/stats
```

### Expected Results
- [ ] Campaign stats match CLI output
- [ ] Response rate calculated correctly
- [ ] For A/B tests: variant breakdown included
- [ ] Insights generated when sufficient data

---

## Test 9: Error Handling

### Objective
Verify graceful handling of errors.

### Test Cases

1. **Invalid CSV path:**
```bash
npx tsx scripts/run-campaign.ts --csv="nonexistent.csv" --name="Test" --message="Test"
```
- [ ] Clear error message displayed

2. **Missing required arguments:**
```bash
npx tsx scripts/run-campaign.ts --csv="test.csv"
```
- [ ] Help text displayed

3. **Conflicting message options:**
```bash
npx tsx scripts/run-campaign.ts --csv="test.csv" --name="Test" \
  --message="Single" --message-a="Variant A" --message-b="Variant B"
```
- [ ] Error about conflicting options

---

## Test 10: End-to-End Flow

### Objective
Complete campaign lifecycle test.

### Steps

1. Prepare CSV with 3-5 test contacts
2. Run campaign:
```bash
npx tsx scripts/run-campaign.ts \
  --csv="e2e-test.csv" \
  --name="E2E-Test-$(date +%Y%m%d)" \
  --message="Hi {firstName}, testing from {city}." \
  --skip-dedup
```

3. Verify:
   - [ ] All contacts created in Pipedrive
   - [ ] Messages queued to QStash
   - [ ] Messages delivered (wait for delays)
   - [ ] Stats accurate

4. Reply from one phone
5. Verify:
   - [ ] Response tracked in stats
   - [ ] Activity logged in Pipedrive

6. Reply "STOP" from another phone
7. Verify:
   - [ ] Opt-out tracked
   - [ ] Phone in opt-out list

---

## Cleanup

After testing:

1. Delete test contacts from Pipedrive
2. Clear test campaigns from Redis (optional, they expire in 90 days)
3. Remove test phone from opt-out list if needed:
```bash
# Via Redis CLI or Upstash console
SREM optouts:phones "+1XXXXXXXXXX"
```

---

## Known Issues

1. **QStash Signature Verification:** Currently disabled. Messages are delivered without signature verification.

2. **Self-Texting:** Cannot send SMS to the same number as QUO_PHONE_NUMBER.

---

## Test Data Template

Save as `test-campaign.csv`:

```csv
Primary Name,Primary Mobile Phone1,Primary Mobile 1 Status,City,Subdivision,Address,ZIP,Primary Email1,Secondary Name,Secondary Mobile Phone1
TEST USER ONE,YOUR-TEST-PHONE-1,Active,BOSTON,BEACON HILL,123 TEST ST,02101,test1@example.com,,
TEST USER TWO,YOUR-TEST-PHONE-2,Active,CAMBRIDGE,HARVARD SQ,456 TEST AVE,02138,test2@example.com,,
```

Replace `YOUR-TEST-PHONE-X` with actual test phone numbers.
