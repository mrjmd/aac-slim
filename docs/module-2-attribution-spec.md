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

### 3.4 Output Format: Middleware-Based Reporting

**Design Decision:** Store attribution data in Redis and generate reports via middleware. QuickBooks tier limitations (custom field limits, tag restrictions) make QB-native storage impractical. This approach gives us full control and scales better.

**Data Storage:**
| Data | Location | Key Pattern |
|------|----------|-------------|
| Attribution results | Redis | `attribution:{invoiceId}` → `{salesRep, commission, date, ...}` |
| Salesperson config | Redis/Env | `config:salespeople` → `{id, name, rate}` |
| Processed invoices | Redis | `attribution:processed:{invoiceId}` → timestamp |

**Benefits:**
- No QuickBooks plan upgrade needed
- Unlimited salespeople with individual commission rates
- Full control over report format
- Can automate email delivery in future

### 3.5 Reporting

**Report Triggers:**

| Trigger | Description | Use Case |
|---------|-------------|----------|
| **On-demand** | Manual API call with date range | "How much did Ed earn this quarter?" |
| **Scheduled** | Monthly on 1st (previous month) | Automated payroll reports |

**On-Demand Endpoint:**
```
GET /api/reports/commissions?startDate=2025-12-01&endDate=2025-12-31
GET /api/reports/commissions?salesRep=ed&startDate=2025-10-01&endDate=2025-12-31
```

**Output Formats:**

1. **JSON Response** (for API/programmatic use)
2. **HTML Table** (copy-paste into email)
3. **SMS Summary** (via Quo to owner)

**Report Example:**
```
AAC Commission Report
Period: Dec 1 - Dec 31, 2025

Sales Rep: Ed Smith
Commission Rate: 20%

Invoice #  | Customer      | Paid Date  | Amount    | Commission
-----------|---------------|------------|-----------|------------
1234       | John Doe      | 12/05/25   | $5,000    | $1,000
1235       | Jane Smith    | 12/12/25   | $3,500    | $700
1241       | Mike Johnson  | 12/28/25   | $8,000    | $1,600
-----------|---------------|------------|-----------|------------
TOTAL                                    $16,500    | $3,300
```

### 3.6 Delivery Phases

**Phase 1 (MVP):**
- On-demand endpoint with date range parameters
- Returns HTML table (copy-paste ready)
- SMS summary sent via Quo: "Dec commissions: Ed $3,300 (3 jobs)"

**Phase 2 (Automation):**
- Scheduled monthly job (Vercel Cron)
- Runs on 1st of month for previous month
- Sends SMS summary automatically

**Phase 3 (Full Automation - Future):**
- Gmail API integration
- Send formatted report from your email address
- Direct to payroll company
- No manual steps required

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
         │ 2. Look up Pipedrive Person (Redis mapping)
         │ 3. Traverse referral chain in Pipedrive
         │ 4. Find salesperson (owner at top of chain)
         │ 5. Calculate commission (amount × rate)
         │ 6. Store result in Redis
         ▼
┌─────────────────┐
│      Redis      │
│  (Attribution   │
│    Results)     │
└────────┬────────┘
         │
         ▼
┌─────────────────────────────────────────┐
│            Report Generation            │
├─────────────────┬───────────────────────┤
│   HTML Table    │    SMS Summary        │
│ (copy-paste)    │   (via Quo)           │
└─────────────────┴───────────────────────┘
```

### 4.2 New Components Needed

| Component | Purpose |
|-----------|---------|
| `src/clients/quickbooks.ts` | Add: `getPaidInvoices()` |
| `src/clients/pipedrive.ts` | Add: `getPersonReferredBy()`, `getPipedriveUser()` |
| `src/lib/attribution.ts` | New: Chain traversal + commission calculation |
| `src/lib/report-generator.ts` | New: Format results as HTML table, SMS summary |
| `api/jobs/attribution.ts` | New: Endpoint to run attribution |
| `api/reports/commissions.ts` | New: On-demand report endpoint |

### 4.3 Pipedrive Custom Field

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

1. **Find Pipedrive "Referred by" Field Key**
   - Query `GET /personFields`
   - Store the hash key for use in lookups

2. **QuickBooks Invoice Fetching**
   - Add `getPaidInvoices(startDate, endDate)` to QB client
   - Returns invoices with Balance = 0 (fully paid)

3. **Pipedrive Chain Traversal**
   - Implement `getPersonReferredBy(personId)`
   - Implement recursive chain traversal
   - Get salesperson name from `owner_id` → Pipedrive User
   - Handle edge cases (no referral, circular, missing)

4. **Commission Calculation**
   - Single hardcoded rate (20%) initially
   - Calculate: Invoice Total × 0.20

5. **Store Results in Redis**
   - Key: `attribution:{invoiceId}`
   - Value: `{invoiceNum, customer, amount, salesRep, commission, paidDate}`

6. **Report Generation**
   - HTML table format (copy-paste ready)
   - SMS summary via Quo

7. **On-Demand Endpoint**
   - `GET /api/reports/commissions?startDate=X&endDate=Y`
   - Optional: `&salesRep=name` filter
   - Returns HTML table + sends SMS summary

### Phase 2.2: Automation & Polish

1. **Scheduled Execution**
   - Vercel Cron job
   - Run monthly (1st of month, process previous month)
   - Auto-send SMS summary

2. **Deduplication**
   - Track processed invoices in Redis
   - Option to re-run and update existing records

3. **Configurable Commission Rates**
   - Move rates to Redis/config
   - Support multiple salespeople with different rates

4. **Error Handling & Reporting**
   - Log invoices that couldn't be attributed
   - Include "unattributed" section in report

### Phase 2.3: Full Automation (Future)

1. **Gmail API Integration**
   - Connect Gmail via OAuth
   - Send formatted report from your email address
   - Direct to payroll company automatically

2. **Pipedrive Activity Logging** (Optional)
   - Log commission activity on salesperson record
   - Provides visibility without leaving CRM

3. **Estimate → Deal Sync** (If Needed)
   - QB Estimate created → Pipedrive Deal created
   - Provides sales pipeline visibility

---

## 6. Dependencies & Prerequisites

### Required Before Starting

- [x] QuickBooks OAuth working (Module 1.4)
- [x] Pipedrive ↔ QB customer mapping in Redis
- [x] Quo SMS sending working (for report summaries)
- [ ] "Referred by" custom field key from Pipedrive

### API Permissions Needed

| API | Scope/Permission | Status |
|-----|------------------|--------|
| QuickBooks | `com.intuit.quickbooks.accounting` | Already have |
| Pipedrive | Read persons, read users, read custom fields | Already have |
| Quo | Send SMS | Already have |

**No new APIs required!** Everything uses existing integrations.

---

## 7. Resolved Questions

| Question | Answer |
|----------|--------|
| "Referred by" field name | "Referred by" (need to get field key hash) |
| Output format | Middleware-based (Redis storage + HTML/SMS reports) |
| Initial run scope | Last 2 weeks |
| Going forward | On-demand initially, then monthly scheduled job |
| QuickBooks storage | Not using - QB tier limitations make it impractical |

---

## 8. Remaining Questions

1. **Should we log invoices that couldn't be attributed?**
   - Include in report as "Unattributed" section?
   - Or skip silently?

2. **What happens if we re-run for same date range?**
   - Overwrite existing attribution?
   - Skip already-processed invoices?
   - Probably: Allow re-run, update existing records

3. **What's the salesperson's name for the initial setup?**
   - Need this for commission config

---

## 9. Success Criteria

Attribution Engine is "done" when:

- [ ] Given any paid QB invoice, system can identify the salesperson
- [ ] Commission is calculated correctly (20% of gross)
- [ ] Results stored in Redis for reporting
- [ ] On-demand endpoint returns HTML table for any date range
- [ ] SMS summary sent via Quo
- [ ] Edge cases are handled gracefully (logged, not crashed)

---

## 10. Complexity Assessment

| Component | Effort | Notes |
|-----------|--------|-------|
| QB Invoice fetching | Low | Straightforward API call |
| "Referred by" field lookup | Low | One-time API query |
| Chain traversal | Medium | Recursive logic, edge cases |
| Commission calculation | Low | Simple math |
| Redis storage | Low | Simple key-value |
| Report generation | Low | String formatting |
| SMS summary | Low | Already have Quo client |
| On-demand endpoint | Low | Query Redis, format output |
| **Total** | **Medium** | Simpler than original QB approach |

**Key Simplification:** By storing data in Redis instead of QuickBooks:
- No QB plan upgrade needed
- No custom field limitations
- Full control over report format
- Can scale to any number of salespeople
