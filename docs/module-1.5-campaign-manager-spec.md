# Module 1.5: Outbound SMS Campaign Manager

**Version:** 1.0
**Date:** December 30, 2024
**Status:** Planning

---

## 1. Business Context

### The Goal

Cold outreach to homeowners via SMS to generate leads. The system needs to:
1. Import lists from Property Radar
2. Create contacts in Pipedrive (so data is ready if they convert)
3. Send personalized SMS via Quo
4. Track responses and opt-outs
5. A/B test message variants to optimize conversion

### Volume & Cadence

- **Daily volume:** 125 homeowners per business day
- **Frequency:** Ongoing, continuous process
- **Throttling:** 1 message every 2-3 seconds (not instant bulk)

### Key Insight

This is a numbers game with optimization potential. A/B testing and response tracking can meaningfully improve conversion rates over time.

---

## 2. Data Source: Property Radar CSV

### Available Fields

| Field | Example | Use |
|-------|---------|-----|
| `Primary Name` | "JON LINKER" | Personalization (first name) |
| `Primary Mobile Phone1` | "339-222-4624" | Send SMS |
| `Primary Mobile 1 Status` | "Active" | Filter valid phones |
| `City` | "BRAINTREE" | Personalization |
| `Subdivision` | "BRAINTREE" | Neighborhood personalization |
| `Address` | "455 MIDDLE ST" | Store in Pipedrive |
| `ZIP` | "02184" | Store in Pipedrive |
| `Est Value` | "767509" | Targeting/segmentation |
| `Est Equity $` | "402357" | Targeting/segmentation |
| `Yr Built` | "1954" | Targeting (older homes) |
| `Primary Email1` | "linker@example.com" | Store in Pipedrive |
| `Secondary Name` | "AIMEE LINKER" | Second homeowner |
| `Secondary Mobile Phone1` | "781-316-1658" | Optional: text both |

### Name Parsing Required

- Input: "JON LINKER" (all caps)
- Output: firstName: "Jon", lastName: "Linker" (title case)

### Phone Normalization Required

- Input: "339-222-4624"
- Output: "+13392224624" (E.164)

---

## 3. Requirements

### 3.1 Campaign Workflow

```
┌─────────────────┐
│  Upload CSV     │
│ (Property Radar)│
└────────┬────────┘
         │ Parse & validate
         ▼
┌─────────────────┐
│ Create Campaign │
│ - Name          │
│ - Message(s)    │
│ - Schedule      │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  For each row:  │
│ 1. Parse name   │
│ 2. Normalize    │◄─── Before sending
│    phone        │
│ 3. Create PD    │
│    contact      │
│ 4. Queue SMS    │
└────────┬────────┘
         │ Throttled (2-3 sec intervals)
         ▼
┌─────────────────┐
│   Send SMS      │
│   via Quo       │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Track Response  │
│ (via Quo webhook│
│  already built) │
└─────────────────┘
```

### 3.2 Message Personalization

**Template Variables:**
```
Hi {firstName}, I noticed you're a homeowner in {city}.
We're doing work in your area...
```

| Variable | Source |
|----------|--------|
| `{firstName}` | Parsed from `Primary Name` |
| `{city}` | `City` field |
| `{neighborhood}` | `Subdivision` field (if different from city) |

### 3.3 A/B Testing

**Concept:** Define 2-4 message variants per campaign. System randomly assigns each recipient to a variant and tracks performance.

**Variant Definition:**
```json
{
  "campaign": "Winter 2024",
  "variants": [
    {
      "id": "A",
      "message": "Hi {firstName}, I noticed you're in {city}...",
      "weight": 50
    },
    {
      "id": "B",
      "message": "Hey {firstName}! Homeowner in {city}?...",
      "weight": 50
    }
  ]
}
```

**Tracking Metrics:**
| Metric | How to Calculate |
|--------|------------------|
| Sent | Count of messages sent per variant |
| Responses | Count of inbound messages from recipients |
| Positive responses | Messages NOT containing opt-out keywords |
| Opt-outs | Messages containing "stop", "unsubscribe", etc. |
| Response rate | Responses / Sent |
| Conversion rate | Future: Track through to closed deal |

**Smart Suggestions (Future):**
- "Variant A has 15% higher response rate. Consider pausing B."
- "Messages sent at 10am have 2x response rate vs 4pm."

### 3.4 Opt-Out Handling

**Keywords to detect:**
- STOP, CANCEL, UNSUBSCRIBE, QUIT, END
- Case-insensitive
- Whole word match (avoid false positives like "I can't stop thinking about it")

**Storage:**
- Pipedrive custom field: "SMS Opt-Out" (checkbox)
- When opt-out detected:
  1. Mark person as opted-out in Pipedrive
  2. Add to Redis blocklist for fast lookup
  3. Never send them another campaign message

**Compliance Note:** A2P 10DLC requires honoring opt-outs. This is already in place.

### 3.5 Scheduling & Throttling

**Scheduling Options:**
- Immediate start (begins throttled sending now)
- Scheduled start (e.g., "Start at 9:00 AM tomorrow")
- Time window (e.g., "Only send between 9 AM - 5 PM")

**Throttling:**
- **Rate:** 1 message every 2-3 seconds (randomized to appear human)
- **Daily limit:** 125 messages (configurable)
- **Carrier considerations:** Quo handles carrier-level throttling

**Queue Implementation:**
- Use Upstash QStash for delayed message delivery
- Each message scheduled with incremental delay: 0s, 2s, 5s, 8s, ...
- Or: Store queue in Redis, process via scheduled function every 10 seconds

### 3.6 Pre-Send: Create Pipedrive Contact

**Before texting, create contact in Pipedrive with:**

| Pipedrive Field | CSV Source |
|-----------------|------------|
| Name | `Primary Name` (title-cased) |
| Phone | `Primary Mobile Phone1` (normalized) |
| Email | `Primary Email1` |
| Address | `Address`, `City`, `ZIP` |
| Lead Source | "Property Radar Campaign" |
| Custom: Campaign Name | Campaign identifier |
| Custom: Message Variant | Which A/B variant they received |

**Why create before texting?**
- If they respond, we already have their data
- Activity logging already works (Module 1.1)
- AI entity extraction already works (Module 1.3)
- Full history is captured from the start

---

## 4. Technical Design

### 4.1 Architecture Options

**Option A: Local CLI Tool**
```
┌─────────────────┐
│  Local Node.js  │
│     Script      │
├─────────────────┤
│ - Parse CSV     │
│ - Create PD     │
│ - Queue to Redis│
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  Vercel Cron    │
│  (every 10 sec) │
│ - Dequeue       │
│ - Send via Quo  │
└─────────────────┘
```

**Pros:** Simple, no auth needed
**Cons:** Must run locally to start campaign

**Option B: Simple Web UI**
```
┌─────────────────┐
│  Next.js App    │
│  (Local or      │
│   Deployed)     │
├─────────────────┤
│ - Upload CSV    │
│ - Create camp.  │
│ - View stats    │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│   API Routes    │
│  + QStash/Cron  │
└─────────────────┘
```

**Pros:** Easier to use day-to-day, can view stats
**Cons:** More to build

**Recommendation:** Start with **Option A (CLI)** to prove the flow, then add UI if needed.

### 4.2 Queue System: Upstash QStash

**Why QStash:**
- Native delay support (no polling needed)
- Free tier: 500 messages/day (enough for 125/day × 3 buffer)
- Integrates with existing Upstash account
- Handles retries

**Flow:**
1. CLI parses CSV, creates Pipedrive contacts
2. For each contact, schedule QStash message with delay
3. QStash calls `/api/campaign/send` at scheduled time
4. Endpoint sends SMS via Quo, logs result

### 4.3 Data Models

**Campaign (Redis hash):**
```json
{
  "id": "campaign-2024-12-30",
  "name": "Winter 2024 Outreach",
  "status": "running",
  "variants": [...],
  "schedule": {
    "startTime": "2024-12-30T09:00:00",
    "endTime": "2024-12-30T17:00:00"
  },
  "stats": {
    "total": 125,
    "sent": 45,
    "responses": 3,
    "optOuts": 1
  }
}
```

**Message Queue Item (QStash payload):**
```json
{
  "campaignId": "campaign-2024-12-30",
  "pipedrivePersonId": 12345,
  "phone": "+13392224624",
  "message": "Hi Jon, I noticed you're in Braintree...",
  "variant": "A"
}
```

**Opt-Out List (Redis set):**
```
optouts:phones → ["+13392224624", "+17815551234", ...]
```

### 4.4 New Components Needed

| Component | Purpose |
|-----------|---------|
| `src/lib/csv-parser.ts` | Parse Property Radar CSV, normalize data |
| `src/lib/campaign.ts` | Campaign CRUD, variant assignment, stats |
| `src/lib/queue.ts` | QStash integration for delayed sending |
| `api/campaign/send.ts` | Endpoint called by QStash to send SMS |
| `api/campaign/stats.ts` | Get campaign stats (for CLI/UI) |
| `scripts/run-campaign.ts` | CLI to import CSV and start campaign |

### 4.5 Response Tracking

**Already Built:** Quo webhook (Module 1.1) captures all inbound messages.

**Additions Needed:**
1. When message received, check if sender was part of a campaign
2. If yes, increment response count for their variant
3. Check for opt-out keywords, mark if found

**Implementation:**
```typescript
// In Quo webhook handler
const campaigns = await getRecentCampaignsForPhone(phone);
if (campaigns.length > 0) {
  await incrementCampaignResponse(campaigns[0].id, campaigns[0].variant);

  if (isOptOut(messageBody)) {
    await markOptOut(phone, pipedrivePersonId);
  }
}
```

---

## 5. Implementation Phases

### Phase 1: Core Campaign Flow (MVP)

1. **CSV Parsing**
   - Read Property Radar CSV
   - Normalize names (title case)
   - Normalize phones (E.164)
   - Validate required fields

2. **Pipedrive Contact Creation**
   - Create Person with all available data
   - Add campaign tracking fields
   - Handle duplicates (skip if phone exists)

3. **Message Queue**
   - Set up QStash integration
   - Schedule messages with staggered delays
   - Create `/api/campaign/send` endpoint

4. **Basic Sending**
   - Single message template (no A/B yet)
   - Send via Quo API
   - Log success/failure

5. **CLI Tool**
   - `npm run campaign:start -- --csv=export.csv --message="Hi {firstName}..."`
   - Shows progress, handles errors

### Phase 2: A/B Testing & Tracking

1. **Variant Support**
   - Define multiple message variants
   - Random assignment with weights
   - Store variant on Pipedrive contact

2. **Response Tracking**
   - Modify Quo webhook to track campaign responses
   - Increment variant-specific counters

3. **Stats Endpoint**
   - `/api/campaign/stats?id=xxx`
   - Returns sent, responses, opt-outs per variant
   - Response rate calculations

4. **Opt-Out Detection**
   - Keyword matching in inbound messages
   - Mark Pipedrive contact
   - Add to Redis blocklist

### Phase 3: Scheduling & Optimization

1. **Time-Based Scheduling**
   - Set campaign start time
   - Define sending window (e.g., 9 AM - 5 PM)
   - Pause outside window, resume next day

2. **Smart Insights**
   - Track send time → response correlation
   - Surface best performing times
   - Variant performance comparison

3. **Simple UI (Optional)**
   - Upload CSV
   - Define message variants
   - View campaign stats
   - Could be local Next.js app

---

## 6. Dependencies & Prerequisites

### Required Before Starting

- [x] Quo SMS sending works (Module 1.1)
- [x] Pipedrive contact creation works
- [x] Quo webhook captures responses
- [ ] Upstash QStash account/setup
- [ ] Campaign tracking custom fields in Pipedrive

### New Environment Variables

```
QSTASH_TOKEN=xxx           # Upstash QStash auth
QSTASH_CURRENT_URL=https://aac-middleware.vercel.app  # For callbacks
```

### Pipedrive Custom Fields to Add

| Field | Type | Purpose |
|-------|------|---------|
| Lead Source | Text/Dropdown | "Property Radar Campaign" |
| Campaign Name | Text | Which campaign they're in |
| Message Variant | Text | A/B variant assigned |
| SMS Opt-Out | Checkbox | Do not contact |

---

## 7. Complexity Assessment

| Component | Effort | Notes |
|-----------|--------|-------|
| CSV parsing | Low | Standard parsing + normalization |
| Pipedrive bulk creation | Low | Already have creation logic |
| QStash integration | Medium | New service, but well-documented |
| Message queue/throttling | Medium | Core complexity |
| Basic sending | Low | Already have Quo client |
| A/B variant assignment | Low | Random + storage |
| Response tracking | Medium | Modify existing webhook |
| Opt-out handling | Low | Keyword matching + flag |
| Stats/reporting | Medium | Aggregation queries |
| CLI tool | Low | Node.js script |
| **Total** | **Medium-High** | More moving parts than Attribution |

### Comparison: Attribution vs Campaign Manager

| Aspect | Attribution | Campaign Manager |
|--------|-------------|------------------|
| New APIs | None | QStash |
| New concepts | Chain traversal | Queue, throttling, A/B |
| UI needed | No | CLI minimum, UI nice-to-have |
| Ongoing use | Monthly batch | Daily use |
| **Overall** | **Simpler** | **More complex** |

---

## 8. Resolved Questions

| Question | Decision |
|----------|----------|
| **Secondary contacts** | Yes, text both primary and secondary mobile numbers |
| **Duplicate handling** | Check if previously messaged - flag and skip. Critical since opt-outs exist but aren't tracked yet |
| **Message length** | Keep within single SMS (160 chars) for cost efficiency |
| **Weekends** | Include weekends - research shows Saturday has highest conversion rates for B2C |

## 9. SMS Timing Research (2025)

Based on industry research, optimal send times for B2C home services:

**Best Days (ranked):**
1. **Thursday** - Past Monday fatigue, anticipating weekend
2. **Friday** - Good mood, receptive
3. **Saturday** - Highest conversion rates, fewer competing messages

**Worst Day:** Monday (people overwhelmed with week start)

**Best Times:**
| Day | Optimal Window | Why |
|-----|----------------|-----|
| Weekdays | 5-9 PM | After work, 9.4% avg CTR |
| Saturday | 10 AM - 12 PM | People in "planning mode" for home projects |
| Sunday | 4-7 PM | Relaxing, preparing for week |

**Legal Compliance:** TCPA allows texts 8 AM - 9 PM local time.

**Recommendation for Testing:**
- Start with Thursday 2 PM and Saturday 10 AM
- Track response rates by time slot
- Iterate based on data

Sources: [Omnisend](https://www.omnisend.com/blog/best-time-to-send-sms/), [Attentive](https://www.attentive.com/blog/best-time-to-send-sms-marketing), [SimpleTexting](https://simpletexting.com/sms-marketing/campaigns/best-time-to-send/)

## 10. Remaining Questions

1. **Campaign naming convention:** Date-based? Area-based? "Winter-2025-Braintree"?

2. **Existing opt-outs:** Need to import/flag people who've already opted out before building this

---

## 11. Success Criteria

Campaign Manager is "done" when:

- [ ] Can import Property Radar CSV via CLI
- [ ] Contacts created in Pipedrive before texting
- [ ] Messages sent throttled (2-3 sec intervals)
- [ ] A/B variants tracked separately
- [ ] Response rate visible per variant
- [ ] Opt-outs detected and honored
- [ ] 125 messages/day sustainable without issues

---

## 12. Sample CLI Usage

```bash
# Import CSV and start campaign immediately
npm run campaign:start -- \
  --csv="Export-20250824.csv" \
  --name="Winter 2024 Braintree" \
  --message="Hi {firstName}, I noticed you're a homeowner in {city}. We're doing exterior work in your area this winter. Would you like a free estimate?"

# With A/B variants
npm run campaign:start -- \
  --csv="Export-20250824.csv" \
  --name="Winter 2024 Test" \
  --variant-a="Hi {firstName}, I noticed you're in {city}..." \
  --variant-b="Hey {firstName}! Homeowner in {city}?..."

# Check campaign stats
npm run campaign:stats -- --name="Winter 2024 Braintree"

# Output:
# Campaign: Winter 2024 Braintree
# Status: Running
#
# Variant A: 62 sent, 4 responses (6.5%), 1 opt-out
# Variant B: 63 sent, 7 responses (11.1%), 0 opt-outs
#
# ✓ Variant B performing 70% better
```
