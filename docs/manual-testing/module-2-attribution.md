# Module 2: Attribution Engine & Commission Reports

## Overview

This module traces paid invoices in QuickBooks back through Pipedrive referral chains to calculate sales commissions:
- **Trigger**: On-demand API call (future: scheduled monthly job)
- **Action**: Calculate commissions for configured salespeople and generate reports

---

## Prerequisites

### QuickBooks Connected

Attribution requires QuickBooks OAuth to be connected to fetch paid invoices.

1. **Verify connection**: Visit `https://aac-middleware.vercel.app/api/auth/quickbooks/connect`
2. **Should show**: "QuickBooks Connected Successfully!"

### QB ↔ Pipedrive Mappings

For attribution to work, QuickBooks customers must be mapped to Pipedrive persons. Mappings are created automatically when:
- A Pipedrive contact syncs to QuickBooks (Module 1.4)
- You manually create a mapping via the admin endpoint

### Commission Configuration

Currently hardcoded in `src/lib/attribution.ts`:
```typescript
const COMMISSION_RATES: Record<number, { name: string; rate: number }> = {
  24313124: { name: 'Edward Crowell', rate: 0.20 },
};
```

Only salespeople in this list will appear in commission reports. Owner-closed deals (where the owner isn't in this list) show "No commissions owed."

---

## Test 2.1: Basic Commission Report (No Commissions Owed)

**Goal**: Verify the report endpoint works and correctly shows no commissions when invoices trace to non-commissioned owners.

### Steps

1. **Call the API**:
   ```
   https://aac-middleware.vercel.app/api/reports/commissions?startDate=2025-12-01&endDate=2025-12-31
   ```
2. **Review the HTML output**

### Expected Results

- [ ] Returns HTML report with title "AAC Commission Report"
- [ ] Shows period "Dec 1, 2025 - Dec 31, 2025"
- [ ] If no commissioned sales, shows "No commissions owed in this period."
- [ ] No errors

---

## Test 2.2: JSON Format Report

**Goal**: Verify JSON output format for programmatic use.

### Steps

1. **Call the API with format=json**:
   ```
   https://aac-middleware.vercel.app/api/reports/commissions?startDate=2025-12-01&endDate=2025-12-31&format=json
   ```

### Expected Results

- [ ] Returns JSON with `success: true`
- [ ] Contains `report.period.startDate` and `endDate`
- [ ] Contains `report.summaries` array (empty if no commissions)
- [ ] Contains `report.totalInvoiceCount`, `totalInvoiceAmount`, `totalCommission`

---

## Test 2.3: Run Attribution with Report

**Goal**: Verify the `run=true` parameter processes invoices before reporting.

### Steps

1. **Call with run=true**:
   ```
   https://aac-middleware.vercel.app/api/reports/commissions?startDate=2025-12-01&endDate=2025-12-31&format=json&run=true
   ```

### Expected Results

- [ ] Response includes `attributionRun` object
- [ ] Shows `processed` count (number of paid invoices in date range)
- [ ] Shows `attributed` count (invoices matched to commissioned salespeople)
- [ ] Shows `unattributed` array with reasons for any failures

---

## Test 2.4: SMS Summary

**Goal**: Verify SMS summary is sent when requested.

### Steps

1. **Call with sendSms=true**:
   ```
   https://aac-middleware.vercel.app/api/reports/commissions?startDate=2025-12-01&endDate=2025-12-31&sendSms=true
   ```
2. **Check your phone** for SMS

### Expected Results

- [ ] SMS received at configured alert phone number
- [ ] Message format: `Dec commissions: No commissions owed.` (or salesperson totals if applicable)
- [ ] Under 160 characters

---

## Test 2.5: Commission Calculation for Salesperson

**Goal**: Verify correct commission calculation when an invoice traces to a commissioned salesperson.

### Prerequisites

This test requires:
1. A paid invoice in QuickBooks
2. The QB customer mapped to a Pipedrive person
3. That person's owner (or top of referral chain) is Edward Crowell

### Steps

1. **Identify a customer** in QuickBooks owned by Ed in Pipedrive
2. **Create the QB↔PD mapping** if not exists:
   ```
   POST https://aac-middleware.vercel.app/api/admin/create-mapping?qbId=XXX&pipedriveId=YYY
   ```
3. **Run attribution**:
   ```
   https://aac-middleware.vercel.app/api/reports/commissions?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD&format=json&run=true&reprocess=true
   ```

### Expected Results

- [ ] Invoice appears in `report.results`
- [ ] `salesRepName` is "Edward Crowell"
- [ ] `commissionRate` is 0.2 (20%)
- [ ] `commissionAmount` equals `invoiceAmount * 0.2`
- [ ] Report summary shows Ed's total commission

---

## Test 2.6: Referral Chain Traversal

**Goal**: Verify that the "Referred by" chain is correctly traversed.

### Prerequisites

Set up a referral chain in Pipedrive:
1. Person A (owned by Edward Crowell)
2. Person B with "Referred by" = Person A
3. Person C (the customer) with "Referred by" = Person B
4. QB Customer mapped to Person C

### Steps

1. **Create the mapping** for the QB customer to Person C
2. **Run attribution** for the date range containing that customer's paid invoice
3. **Check the result**

### Expected Results

- [ ] `referralChain` array shows [Person C ID, Person B ID, Person A ID]
- [ ] Commission attributed to Edward Crowell (Person A's owner)
- [ ] Chain traversal stops at Person A (no "Referred by")

---

## Test 2.7: Reprocess Flag

**Goal**: Verify that `reprocess=true` re-calculates already-processed invoices.

### Steps

1. **Run attribution once**:
   ```
   ...&run=true
   ```
2. **Run again without reprocess**:
   ```
   ...&run=true
   ```
3. **Run with reprocess**:
   ```
   ...&run=true&reprocess=true
   ```

### Expected Results

- [ ] First run: `attributed` shows count of processed invoices
- [ ] Second run: `skipped` shows same count (already processed)
- [ ] Third run with reprocess: `attributed` shows count again (re-processed)

---

## Test 2.8: Check Mapping Endpoint

**Goal**: Verify the admin endpoint for checking mappings works.

### Steps

1. **Check a QB customer mapping**:
   ```
   https://aac-middleware.vercel.app/api/admin/check-mapping?qbId=151
   ```
2. **Check a Pipedrive person mapping**:
   ```
   https://aac-middleware.vercel.app/api/admin/check-mapping?pipedriveId=905
   ```

### Expected Results

- [ ] Returns `qbToPipedrive` with Pipedrive ID (or null if not mapped)
- [ ] Returns `pipedriveToQb` with QB ID (or null if not mapped)

---

## Test 2.9: Create Mapping Endpoint

**Goal**: Verify manual mapping creation works.

### Steps

1. **Create a test mapping**:
   ```
   POST https://aac-middleware.vercel.app/api/admin/create-mapping?qbId=999&pipedriveId=888
   ```
2. **Verify with check-mapping**:
   ```
   https://aac-middleware.vercel.app/api/admin/check-mapping?qbId=999
   ```

### Expected Results

- [ ] Create returns `success: true` with mapping details
- [ ] Check confirms mapping exists in both directions

### Cleanup

Mappings auto-expire after 7 days, or you can ignore test mappings.

---

## Troubleshooting

### "No commissions owed" but expected commissions

1. **Check QB↔PD mapping exists**: Use `/api/admin/check-mapping?qbId=XXX`
2. **Check the person's owner in Pipedrive**: Must be Edward Crowell (ID 24313124)
3. **Check the referral chain**: If "Referred by" is set, trace up to the top
4. **Verify invoice is paid**: Only Balance = 0 invoices are processed

### Invoice not appearing in results

1. **Check date range**: Invoice date must be within startDate/endDate
2. **Check if already processed**: Run with `reprocess=true` to re-process
3. **Check QB customer mapping**: Use check-mapping endpoint

### Wrong salesperson attributed

1. **Check "Referred by" chain** in Pipedrive - commission goes to owner at top of chain
2. **Verify owner_id** on the top person in the chain
3. **Check COMMISSION_RATES** in attribution.ts includes that user ID

### SMS not received

1. **Check Quo API key** is valid
2. **Check ALERT_PHONE_NUMBER** env var
3. **Check QUO_PHONE_NUMBER** (from number) is valid
4. **Review logs** for SMS send errors

---

## API Reference

### GET /api/reports/commissions

Generate commission report for a date range.

**Query Parameters:**
| Param | Required | Default | Description |
|-------|----------|---------|-------------|
| startDate | Yes | - | Start date (YYYY-MM-DD) |
| endDate | Yes | - | End date (YYYY-MM-DD) |
| format | No | html | Output format: `html`, `json`, or `text` |
| sendSms | No | false | Send SMS summary to owner |
| run | No | false | Run attribution before reporting |
| reprocess | No | false | Re-process already attributed invoices |

### POST /api/admin/create-mapping

Manually create a QB↔Pipedrive mapping.

**Query Parameters:**
| Param | Required | Description |
|-------|----------|-------------|
| qbId | Yes | QuickBooks Customer ID |
| pipedriveId | Yes | Pipedrive Person ID |

### GET /api/admin/check-mapping

Check if mappings exist.

**Query Parameters:**
| Param | Required | Description |
|-------|----------|-------------|
| qbId | No | QuickBooks Customer ID to look up |
| pipedriveId | No | Pipedrive Person ID to look up |

### POST /api/admin/backfill-mappings

Scan invoices and report which customers need mappings.

**Query Parameters:**
| Param | Required | Description |
|-------|----------|-------------|
| startDate | Yes | Start date (YYYY-MM-DD) |
| endDate | Yes | End date (YYYY-MM-DD) |
