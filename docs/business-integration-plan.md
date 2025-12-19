# Business Systems Integration Plan: The "Crawl, Walk, Run" Architecture

**Version:** 1.4
**Date:** December 19, 2025
**Status:** In Progress

---

## 1. Executive Summary

This project transitions the business from a monolithic custom software build to a **Composable Architecture**. We will utilize best-in-class SaaS products (Pipedrive, Quo, QuickBooks, Google Workspace) connected by lightweight, custom middleware.

### The Golden Rules of Data

| System | Role |
|--------|------|
| **Pipedrive** | Relationship Source of Truth (Who knows who) |
| **QuickBooks** | Financial Source of Truth (Who paid what) |
| **Quo** | Communication Source of Truth (What was said) |

**Middleware** handles the logic, attribution, and movement of data. It is stateless and invisible.

---

## 2. System Architecture Diagram

```mermaid
graph TD
    User(User/Salesperson)

    subgraph "The Relationship Engine"
        PD[Pipedrive CRM]
    end

    subgraph "The Comm Engine"
        Quo[Quo (OpenPhone)]
        ZI[ZoomInfo]
    end

    subgraph "The Money Engine"
        QB[QuickBooks Online]
    end

    subgraph "The Scheduler"
        GCal[Google Calendar]
    end

    subgraph "The Marketing Engine"
        Gemini[Gemini API (Nano Banana)]
        ContentStore[Google Drive/Airtable]
    end

    subgraph "Middleware (The Traffic Cop)"
        MW_Sync[Node.js Sync Service]
        MW_AI[AI Listener (LLM)]
        MW_Attr[Attribution Batch Job]
        MW_Camp[Campaign Manager]
        MW_Mktg[Content Generator]
    end

    %% Flows
    User -->|Exports Lead| PD
    ZI -->|Exports Lead| PD

    %% Quo Sync
    Quo -->|Webhook: Call/Text| MW_Sync
    MW_Sync -->|Log Activity| PD
    MW_Sync -->|Sync Contact| Quo

    %% AI Layer
    Quo -->|Webhook: Transcript| MW_AI
    MW_AI -->|Extract Entity| MW_Sync

    %% Financials
    PD -->|Webhook: Person Created| MW_Sync
    MW_Sync -->|Create/Link Customer| QB
    QB -->|Webhook: Estimate Created| MW_Sync
    MW_Sync -->|Create Deal| PD

    %% Attribution
    QB -->|Paid Invoice Data| MW_Attr
    PD -->|Relationship Graph| MW_Attr
    MW_Attr -->|Commission Report| User

    %% Campaigns
    MW_Camp -->|Batch SMS| Quo

    %% Marketing
    MW_Mktg -->|Generate| Gemini
    Gemini -->|Assets| ContentStore
```

---

## 3. Module Specifications

### Module 1: Communication Intelligence (Quo <-> Pipedrive)

The system that ensures every conversation is logged and actionable.

#### 1.1 The "Loop-Free" Bi-Directional Sync

**Constraint:** Quo segregates "Native Contacts" (created in UI) from "Integration Contacts" (API). We cannot reliably sync Native Contacts to Pipedrive.

> [!WARNING]
> **Verify Quo API Constraints:** This Native vs Integration contact segregation should be verified against current Quo/OpenPhone API documentation before implementation. API behavior may have changed.

**Trigger (Pipedrive -> Quo):** `person.added`, `person.updated`

**Logic:**
1. Middleware checks if phone exists
2. Normalizes to E.164
3. Checks Quo API
4. Creates/Updates Integration Contact

**Loop Protection:** Middleware ignores updates where `last_edit_by = Middleware User ID`

**Trigger (Quo -> Pipedrive):** `call.completed`, `message.received`

**Strategy:** Rely on Activity-Based Creation rather than `contact.created` events.

**Logic:** Middleware searches Pipedrive for phone number involved in the call/text.

**Action:**
- **If Found:** Log Activity (Call/SMS) to that Person
- **If Not Found:** Create "Unknown Lead" Person in Pipedrive immediately, then log Activity. (This triggers the Pipedrive->Quo sync in step 1, pushing the contact back to Quo)

#### 1.2 The AI Listener (The "Smart Ingest")

**Concept:** AI parses unstructured text/audio to structured data, removing the need for manual Quo contact creation.

**Trigger:** `message.received` OR `call.transcript.completed`

**Process:**
1. Send transcript/text to LLM (Gemini 2.5 Flash)
2. Prompt: "Extract the following entities: First Name, Last Name, Street Address, Email, Intent (Booking/Inquiry). Return JSON."

> [!WARNING]
> **AI Confidence Scores:** Gemini does not return confidence scores by default. The "90% confidence" threshold mentioned below cannot be implemented as written. Instead, use Gemini's structured output (JSON mode) and validate the returned fields are non-empty. Consider adding a `"confidence": "high"|"medium"|"low"` field to the prompt for the model to self-assess.

**Action:**
- If high confidence (>90%) & Contact is "Unknown": Update the Pipedrive Contact Name/Address automatically
- If intent = "Booking": Create a "Task" in Pipedrive for the Salesperson: "Booking Request Detected"

#### 1.3 The Campaign Manager (Cold Texting)

**Concept:** A "Thin UI" (React/Next.js) to upload lists and schedule blasts.

**Input:** CSV from Property Radar (Name, Phone, Address)

**Compliance Status:** COMPLETE (A2P 10DLC Registered)

Middleware must still respect "Opt-Out" keywords (STOP, CANCEL) automatically to maintain trust score.

**Throttling:**
- Quo Limit: ~1 message/second per number
- Logic: Queue 100 messages -> Send 1 every `random(30, 60)` seconds to simulate human behavior and avoid carrier flags

> [!WARNING]
> **Queue System Required:** At medium volume (50-500 messages), sending from a serverless function with 30-60s delays will hit Vercel timeout limits. Implement a proper queue system:
> - **Recommended:** Upstash QStash (free tier: 500 msgs/day, handles delays natively)
> - **Alternative:** Store job state in Redis, process in chunks via scheduled function

---

### Module 2: The Financial Link (Pipedrive <-> QuickBooks)

The system that ensures sales data becomes financial data without copy-pasting.

#### 2.1 Contact Synchronization

**Trigger:** Pipedrive `person.added`

**Logic:**
1. Check QBO for existing customer by Email
2. If missing, `POST /customer`
3. **Key Step:** Store Pipedrive Person ID in QBO Notes field or Custom Field `ExternalID`

> [!WARNING]
> **Fragile ID Storage:** Storing the Pipedrive ID in the QBO "Notes" field is brittle—users can accidentally edit or delete it. Better alternatives:
> - Use a QBO Custom Field (more protected from accidental edits)
> - Maintain a mapping table in Redis: `pipedrive:{id} -> qbo:{id}`
> - Store both IDs and cross-reference on lookup

#### 2.2 Estimate -> Deal Sync

**Workflow:** User creates Estimate in QuickBooks -> Middleware creates Deal in Pipedrive

**Logic:**
1. QBO Webhook `Estimate.Create`
2. Middleware gets Customer ID -> Looks up Pipedrive ID
3. Creates Pipedrive Deal: "Estimate #{DocNum}". Value = Estimate Total

#### 2.3 The Attribution Engine (Batch Job)

**Concept:** Recursive commission calculation.

**Frequency:** Nightly or Weekly

**Logic:**
1. Fetch all Paid Invoices from QBO (Last 7 days)
2. For each Invoice, find the Pipedrive Person
3. Trace Relationships:
   - Look at Referral Source field (Agent)
   - Look at Agent's Owner field (Salesperson)
4. Calculate: `Invoice Amt * Agent Commission Rate`

**Output:** Write to "Commissions" Google Sheet or create Pipedrive Activity

---

### Module 3: The Scheduler (Google Calendar Integration)

The invisible sync that requires no UI.

#### 3.1 The "Watch" Sync

**Challenge:** Standard Zapier/Make integrations are often delayed or one-way.

**Solution:** Google Calendar API `events.watch`

**Logic:**
1. Middleware subscribes to the Salesperson's Calendar
2. On Change (Push Notification): Middleware fetches the event
3. **Pipedrive Match:**
   - Extract Attendee Emails
   - Find Pipedrive Person by Email
   - Create/Update Activity in Pipedrive linked to that Person

**Reverse (Pipedrive -> GCal):** Pipedrive standard sync handles this well, or we can mirror logic if custom behavior is needed (e.g., specific naming convention).

---

### Module 4: The Marketing Engine (Brand & Content)

The system to batch-generate branded assets.

#### 4.1 The Content Strategist (Text Generation)

**Input:** User defines a "Theme" (e.g., "Spring Home Maintenance") and "Duration" (e.g., 8 weeks)

**Logic:**
1. Call Gemini 2.5 Flash with Brand Voice Guidelines
2. Generate a CSV containing: Week, Platform, Topic, Post Copy, Image Prompt Description

**Output:** A Google Sheet for human review/edits

#### 4.2 The Asset Factory (Image Generation)

**Model:** Gemini 3 Pro Image ("Nano Banana Pro")

**Brand System Injection:** All prompts are prefixed with brand variables:
- **Style:** "Photorealistic, warm lighting, professional construction, 4k"
- **Color Palette:** "Accents in #FFD700 (Gold) and #333333 (Dark Grey)"
- **Negative Prompt:** "Cartoon, illustration, text overlay, blurry, distorted tools"

**Batch Processing:**
1. Iterate through the Google Sheet from 4.1
2. For each row, generate 3 variants:
   - **Square (1:1):** For Instagram/LinkedIn Feed
   - **Portrait (9:16):** For Reels/TikTok/Stories
   - **Landscape (16:9):** For Blog/Twitter/Web
3. Save to Google Drive folder structure: `/Marketing/{Theme}/Week_{N}/{Platform}.png`

#### 4.3 Future: The Social Scheduler

**Status:** Planned (Run Phase)

**Complexity Note:** Requires Google Business Profile API (Update limits are strict) and LinkedIn API (Token refresh is annoying).

**Strategy:** Use the generated assets from 4.2 and manually schedule in a tool like Buffer/Hootsuite initially, then build custom API connectors later.

---

## 4. Implementation Phases

### Phase 1: The "Crawl" (Core Connectivity)

- [ ] Server Setup: Deploy Node.js middleware (Vercel/AWS)
- [ ] Sync v1: Build Pipedrive <-> Quo 2-way sync (Contact Name & Phone only)
- [ ] Financial v1: Build Pipedrive -> QuickBooks Contact creation
- [x] Compliance: Register for A2P 10DLC (Completed)

### Phase 2: The "Walk" (Intelligence & Sales)

- [ ] AI Listener: Implement LLM parsing for Quo transcripts
- [ ] Campaign App: Build simple UI for CSV upload + Text Blasting
- [ ] Estimate Sync: QuickBooks Estimate -> Pipedrive Deal
- [ ] Marketing v1: Build the Content Strategist & Asset Factory scripts

### Phase 3: The "Run" (Attribution & Scaling)

- [ ] Attribution Engine: Build the revenue tracing script
- [ ] Dashboarding: Connect Commission Google Sheet to a simple visualizer
- [ ] Advanced AI: AI auto-replies to specific intents

---

## 5. Technology Stack

| Component | Technology |
|-----------|------------|
| Middleware Runtime | Node.js (TypeScript) |
| Hosting | Vercel Serverless Functions (Cost effective, scales to zero) |
| Database | Redis (Upstash) for deduping webhooks & caching IDs |
| AI (Text) | Gemini 2.5 Flash (Best for JSON speed) |
| AI (Image) | Gemini 3 Pro Image (Best for Visual Quality) |
| Frontend (Campaigns) | Next.js (React) + Tailwind CSS |
