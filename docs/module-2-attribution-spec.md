# Module 2: Attribution Engine & Financial Sync

**Version:** 1.1
**Date:** December 30, 2024
**Status:** Planning

---

## 1. Business Context

### The Core Problem

When an invoice is paid in QuickBooks, we need to trace back through the relationship chain to find the salesperson who should receive commission. This is not straightforward because:

- The paying customer (homeowner) may have been referred by an intermediary (realtor, agent, etc.)
- That intermediary's relationship may trace back to the salesperson
- The chain can be multiple levels deep

### Example Chain

```
Salesperson: "Bob Sales" (Pipedrive Person - relationship owner)
    ↓ [owns relationship with]
Agent: "Jane Realtor" (Pipedrive Person)
    ↓ [referred]
Customer: "John Smith" (Homeowner in QB, Person in Pipedrive)
    ↓ [pays]
Invoice: $5,000 (QuickBooks)
    ↓ [triggers]
Commission: $1,000 to Bob Sales (20% of gross)
```

### Key Insight

Only the **salesperson at the top of the chain** receives commission. Intermediaries (realtors, agents) do not receive commissions in the current model. This simplifies the calculation but requires reliable chain traversal.

---

## 2. Current State

### Systems Involved

| System | Role | Current State |
|--------|------|---------------|
| **QuickBooks** | Financial source of truth | Estimates, Invoices, Payments tracked here |
| **Pipedrive** | Relationship source of truth | People, Organizations, relationships tracked here |
| **Middleware** | Already syncs contacts | Pipedrive Person → QB Customer sync works |

### Existing Data Structures

**Pipedrive Person:**
- `owner_id` - The Pipedrive user (salesperson) who owns this contact
- Custom field: "Referred by" - Links to another Person ID

**QuickBooks Customer:**
- Created from Pipedrive via Module 1.4
- Mapping stored in Redis: `map:pd-to-qb:{pipedriveId}` → `{qbCustomerId}`

### Commission Structure (Current)

| Salesperson | Commission Rate |
|-------------|-----------------|
| Current sales guy | 20% of gross invoice amount |

**Future:** Commission rates will need to be configurable per salesperson.

---

## 3. Requirements

### 3.1 Relationship Chain Traversal

**Goal:** Given a QuickBooks Customer, find the Pipedrive salesperson at the top of the referral chain.

**Algorithm:**
```
1. QB Customer → Look up Pipedrive Person ID (via Redis mapping)
2. Get Pipedrive Person
3. Check "Referred by" custom field
4. If "Referred by" is set:
   a. Get that Person
   b. Recursively check their "Referred by"
   c. Continue until no more "Referred by" links
5. The final Person in the chain → get their `owner_id`
6. That owner_id is the salesperson who gets commission
```

**Edge Cases:**
- No "Referred by" set → use direct `owner_id` of the customer
- Circular reference → detect and break (log error)
- Missing Person in chain → log error, skip this invoice
- QB Customer not linked to Pipedrive → log warning, skip

### 3.2 Invoice Processing

**Trigger Options:**

| Option | Description | Pros | Cons |
|--------|-------------|------|------|
| **Scheduled Job** | Nightly/weekly batch | Simple, predictable | Not real-time |
| **On-Demand** | Manual trigger via API/UI | Flexible | Requires endpoint |
| **QB Webhook** | `Payment.Create` event | Real-time | More complex |

**Recommended Approach:**
- Primary: On-demand endpoint for running attribution
- Future: Scheduled job (monthly on 1st for previous month)

**Invoice Filtering:**
- Only process invoices marked **Paid** in QuickBooks
- Filter by date range (default: last 2 weeks for initial run)
- Skip invoices already processed (deduplication via Redis)

### 3.3 Commission Calculation

**Formula (Current):**
```
Commission = Invoice Total × Salesperson Commission Rate
```

**Example:**
- Invoice Total: $5,000
- Salesperson: Bob Sales
- Commission Rate: 20%
- Commission: $1,000

**Future Enhancement:** Store commission rates in a configuration:
```json
{
  "salespeople": {
    "12345": { "name": "Bob Sales", "rate": 0.20 },
    "67890": { "name": "New Sales Person", "rate": 0.15 }
  }
}
```

### 3.4 Output Format: QuickBooks Native

**Design Decision:** Store all commission data directly in QuickBooks rather than external systems (Google Sheets). This keeps financial data in the financial system and enables native QB reporting for payroll.

**Hybrid Approach: Sales Rep + Custom Field**

| Field | Type | Purpose |
|-------|------|---------|
| **Sales Rep** | Built-in QB field | Identifies which salesperson gets credit |
| **Commission Amount** | Custom field on Invoice | Stores calculated commission ($) |

**How It Works:**

1. Enable Sales Rep tracking in QB (Settings → Sales → Sales form content)
2. Create a Sales Rep entry for each salesperson
3. Add custom field "Commission Amount" to Invoice form
4. When attribution runs:
   - Update each paid Invoice with the Sales Rep
   - Calculate and store Commission Amount in custom field
5. Run native QB reports: Filter by Sales Rep, date range → see commissions

**Benefits:**
- No new API integration (already have QB OAuth)
- All data stays in QuickBooks (single source of truth for financials)
- Native QB reporting for payroll
- No Google Sheets service account setup

### 3.5 Reporting

**In QuickBooks:**
- Sales by Customer Summary → Filter by Sales Rep
- Custom Reports → Include Commission Amount field
- Export to Excel if needed for further analysis

**Report Periods:**
| Report Type | Description |
|-------------|-------------|
| Monthly | Filter invoices paid in a calendar month |
| Custom Range | User-specified start/end dates |
| By Sales Rep | All commissions for a specific salesperson |

---

## 4. Technical Design

### 4.1 Data Flow

```
┌─────────────────┐
│   QuickBooks    │
│  (Paid Invoices)│
└────────┬────────┘
         │ Fetch via API
         ▼
┌─────────────────┐
│   Middleware    │
│ Attribution Job │
└────────┬────────┘
         │ For each invoice:
         │ 1. Get QB Customer
         │ 2. Look up Pipedrive Person (Redis)
         │ 3. Traverse referral chain
         │ 4. Find salesperson owner
         │ 5. Calculate commission
         │ 6. Update Invoice with Sales Rep + Commission
         ▼
┌─────────────────┐
│   QuickBooks    │
│ (Updated Invoice│
│  with Sales Rep │
│  + Commission)  │
└─────────────────┘
         │
         ▼
    Native QB Reports
    for Payroll
```

### 4.2 New Components Needed

| Component | Purpose |
|-----------|---------|
| `src/clients/quickbooks.ts` | Add: `getPaidInvoices()`, `updateInvoice()`, `getSalesReps()` |
| `src/clients/pipedrive.ts` | Add: `getPersonReferredBy()` (custom field lookup) |
| `src/lib/attribution.ts` | New: Chain traversal + commission calculation logic |
| `api/jobs/attribution.ts` | New: Endpoint to trigger attribution job |

### 4.3 QuickBooks Setup (One-Time)

**Step 1: Enable Sales Rep**
1. Go to Settings (gear icon) → Account and Settings
2. Sales → Sales form content
3. Enable "Custom transaction numbers" if not already
4. The Sales Rep field should be available on invoices

**Step 2: Create Sales Rep Entries**
1. For each salesperson, create a Sales Rep in QB
2. Note the Sales Rep ID (we'll need this for API calls)

**Step 3: Add Commission Amount Custom Field**
1. Go to Settings → Custom fields
2. Add new field on Invoice: "Commission Amount" (Number/Currency type)
3. Note the custom field ID

### 4.4 Pipedrive Custom Field

**"Referred by" Field:**
- Field type: Person (link to another Person)
- Need to query `GET /personFields` to find the field key hash
- Use this key when reading the field from Person records

### 4.5 Redis Keys for Deduplication

```
attribution:processed:{invoiceId} → timestamp
```

Prevents re-processing invoices that have already been attributed.

### 4.6 Configuration Storage

**Commission Rates (Current):**
- Hardcoded: 20% for all salespeople

**Commission Rates (Future):**
Store in Redis:
```
config:commission:rates → {
  "salesRepId1": 0.20,
  "salesRepId2": 0.15
}
```

Or environment variable:
```
COMMISSION_RATES={"default": 0.20}
```

---

## 5. Implementation Phases

### Phase 2.1: Core Attribution (MVP)

1. **QuickBooks Setup**
   - Enable Sales Rep field
   - Create Sales Rep entry for current salesperson
   - Add "Commission Amount" custom field to Invoice

2. **Find Pipedrive "Referred by" Field Key**
   - Query `GET /personFields`
   - Store the hash key for use in lookups

3. **QuickBooks Invoice Fetching**
   - Add `getPaidInvoices(startDate, endDate)` to QB client
   - Returns invoices with Balance = 0 (fully paid)

4. **Pipedrive Chain Traversal**
   - Implement `getPersonReferredBy(personId)`
   - Implement recursive chain traversal
   - Handle edge cases (no referral, circular, missing)

5. **Commission Calculation**
   - Single hardcoded rate (20%) initially
   - Calculate: Invoice Total × 0.20

6. **Update Invoice in QuickBooks**
   - Set Sales Rep field
   - Set Commission Amount custom field
   - Handle sparse update (don't overwrite other fields)

7. **Manual Trigger Endpoint**
   - `POST /api/jobs/attribution`
   - Query params: `startDate`, `endDate` (default: last 2 weeks)
   - Returns: count of invoices processed, any errors

### Phase 2.2: Automation & Polish

1. **Scheduled Execution**
   - Vercel Cron job
   - Run monthly (1st of month, process previous month)

2. **Deduplication**
   - Track processed invoices in Redis
   - Skip already-attributed invoices

3. **Configurable Commission Rates**
   - Move rates to Redis/config
   - Support multiple salespeople with different rates

4. **Error Handling & Logging**
   - Log invoices that couldn't be attributed
   - Surface errors for investigation

### Phase 2.3: Enhanced Features (Future)

1. **Pipedrive Activity Logging** (Optional)
   - Log commission activity on salesperson record in Pipedrive
   - Provides visibility without leaving CRM

2. **Estimate → Deal Sync** (If Needed)
   - QB Estimate created → Pipedrive Deal created
   - Provides sales pipeline visibility

3. **Attribution Dashboard** (If Needed)
   - Simple web UI to view commission summaries
   - Only if QB reporting proves insufficient

---

## 6. Dependencies & Prerequisites

### Required Before Starting

- [x] QuickBooks OAuth working (Module 1.4)
- [x] Pipedrive ↔ QB customer mapping in Redis
- [ ] "Referred by" custom field key from Pipedrive
- [ ] Sales Rep enabled and created in QuickBooks
- [ ] "Commission Amount" custom field added in QuickBooks

### API Permissions Needed

| API | Scope/Permission | Status |
|-----|------------------|--------|
| QuickBooks | `com.intuit.quickbooks.accounting` | Already have |
| Pipedrive | Read persons, read custom fields | Already have |

**No new APIs required!** This is a key simplification from the original Google Sheets approach.

---

## 7. Resolved Questions

| Question | Answer |
|----------|--------|
| "Referred by" field name | "Referred by" (need to get field key hash) |
| Output format | QuickBooks native (Sales Rep + Custom Field) |
| Initial run scope | Last 2 weeks |
| Going forward | On-demand initially, then monthly scheduled job |

---

## 8. Remaining Questions

1. **What is the Sales Rep name for the current salesperson?**
   - Need to create this in QB

2. **Should we log invoices that couldn't be attributed?**
   - Separate log/report for review?
   - Or just skip silently?

3. **What happens if an invoice is already attributed?**
   - Skip and don't update?
   - Or allow re-running to fix errors?

---

## 9. Success Criteria

Attribution Engine is "done" when:

- [ ] Given any paid QB invoice, system can identify the salesperson
- [ ] Commission is calculated correctly (20% of gross)
- [ ] Invoice is updated in QB with Sales Rep and Commission Amount
- [ ] Job can be triggered manually via API endpoint
- [ ] Native QB reports show commissions by Sales Rep
- [ ] Edge cases are handled gracefully (logged, not crashed)

---

## 10. Complexity Assessment

| Component | Effort | Notes |
|-----------|--------|-------|
| QB Invoice fetching | Low | Straightforward API call |
| QB Invoice updating | Low | Sparse update with Sales Rep + custom field |
| "Referred by" field lookup | Low | One-time API query |
| Chain traversal | Medium | Recursive logic, edge cases |
| Commission calculation | Low | Simple math |
| Deduplication | Low | Redis set/check |
| Error handling | Medium | Various failure modes |
| **Total** | **Medium** | Simpler than Google Sheets approach |

**Key Simplification:** By storing data in QuickBooks instead of Google Sheets, we eliminated:
- Google Cloud service account setup
- Google Sheets API integration
- New npm package dependencies
- A separate data store to maintain
