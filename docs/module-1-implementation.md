# Technical Implementation Plan: Module 1 (Communication Intelligence)

**Target System:** Loop-Free Bi-Directional Sync (Pipedrive <-> Quo) + AI Listener
**Tech Stack:** Node.js (TypeScript), Vercel Functions, Upstash Redis, Gemini API

---

## Phase 0: Environment Setup

### Step 1: Project Initialization

Create a new GitHub repo: `business-middleware`

Initialize local Node.js project:

```bash
npm init -y
npm install typescript ts-node @types/node --save-dev
npx tsc --init
```

Install core dependencies:

```bash
npm install express dotenv axios @pipedrive/client @upstash/redis google-auth-library
```

**Vercel Setup:**
1. Install Vercel CLI: `npm i -g vercel`
2. Create `vercel.json` to define route handling (rewriting `/api/*` to your function)

### Step 2: Database (Redis) Setup

**Why:** We need a place to store "processed event IDs" to ensure idempotency and prevent loops.

1. Create free account on [Upstash.com](https://upstash.com)
2. Create a database named `middleware-dedupe`
3. Copy `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` to your `.env` file

> [!WARNING]
> **Define TTL for Dedupe Keys:** The implementation should specify a TTL (Time-To-Live) for dedupe keys to prevent unbounded growth. Recommended:
> - **Webhook dedupe:** 24 hours (`SET key value EX 86400`)
> - **ID mapping cache:** 7 days or permanent
>
> **Key Naming Convention:**
> ```
> dedupe:pipedrive:{webhook_id} -> "processed"
> dedupe:quo:{event_id} -> "processed"
> map:pipedrive:{person_id} -> {quo_contact_id}
> map:quo:{contact_id} -> {pipedrive_person_id}
> ```

### Step 3: API Credentials Gathering

Create a `.env` file with these keys. **Do not commit this file.**

```env
# Pipedrive
PIPEDRIVE_API_KEY=...
PIPEDRIVE_COMPANY_DOMAIN=... # e.g., companyname.pipedrive.com
PIPEDRIVE_USER_ID=... # The ID of the "System Bot" user - critical for loop protection

# Quo (OpenPhone)
QUO_API_KEY=...
QUO_WEBHOOK_SIGNING_SECRET=... # You get this after creating the webhook

# Gemini AI
GOOGLE_API_KEY=... # For AI Listener

# Redis
UPSTASH_REDIS_REST_URL=...
UPSTASH_REDIS_REST_TOKEN=...
```

> [!NOTE]
> **Production Secrets:** For production, use Vercel Environment Variables (encrypted at rest) instead of `.env` files. Never commit secrets to git.

---

## Phase 1: Module 1.1 (The Loop-Free Sync)

### Step 4: Pipedrive -> Quo Sync (The "Phone Book" Push)

**Goal:** When a Person is added/updated in Pipedrive, create/update them in Quo.

**Create Endpoint:** `api/webhooks/pipedrive.ts`

> [!WARNING]
> **Add Webhook Signature Verification:** Pipedrive webhooks support signature verification via the `X-Pipedrive-Signature` header. Implement this to prevent spoofed webhook calls:
> ```typescript
> import crypto from 'crypto';
>
> function verifyPipedriveSignature(payload: string, signature: string, secret: string): boolean {
>   const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');
>   return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
> }
> ```

**Payload Validation:**
1. Check `req.body.meta.user_id`
2. **CRITICAL LOGIC:**
   ```typescript
   if (req.body.meta.user_id === process.env.PIPEDRIVE_USER_ID) {
     return res.status(200).send("Loop prevented");
   }
   ```

**Data Extraction:**
1. Get Name (`current.name`) and Phone (`current.phone`)
2. **Normalization:** Use `libphonenumber-js` to convert phone to E.164 (`+15551234567`). If invalid, ignore.

**Quo Logic:**
1. Search Quo API: `GET /contacts?phone={number}`
2. If Exists: Compare names. If different, `PUT /contacts/{id}`
3. If New: `POST /contacts` with `{ firstName, lastName, phoneNumber, company }`

**Deploy & Test:**
1. Deploy to Vercel
2. Add Webhook URL to Pipedrive (`person.added`, `person.updated`)
3. Test: Create a person in Pipedrive -> Check Quo App

### Step 5: Quo -> Pipedrive Sync (Activity Logging)

**Goal:** Log calls/texts to Pipedrive. Create "Unknown" leads if they don't exist.

**Create Endpoint:** `api/webhooks/quo.ts`

**Signature Verification:** Validate the `openphone-signature` header using your secret.

**Event Filter:** Only process `call.completed` and `message.received`.

> [!WARNING]
> **Add Error Handling & Retry Logic:** The current implementation doesn't handle API failures. Wrap external API calls in try/catch and implement retry:
> ```typescript
> async function withRetry<T>(fn: () => Promise<T>, maxRetries = 3): Promise<T> {
>   for (let i = 0; i < maxRetries; i++) {
>     try {
>       return await fn();
>     } catch (error) {
>       if (i === maxRetries - 1) throw error;
>       await new Promise(r => setTimeout(r, 1000 * Math.pow(2, i))); // Exponential backoff
>     }
>   }
>   throw new Error('Max retries exceeded');
> }
> ```
>
> For persistent failures, queue the event for later processing (see Error Handling section below).

**Pipedrive Lookup:**
1. Extract remote phone number
2. Search Pipedrive: `GET /persons/search?term={number}`

**The Fork (Create vs. Log):**

| Scenario | Action |
|----------|--------|
| **Found** | Get Person ID, proceed to log activity |
| **Not Found** | Create new Person with Name: "Unknown Lead {number}". This creation triggers the Pipedrive webhook from Step 4. Step 4 will see the "System User ID" and exit, preventing the loop. |

**Log Activity:**
```typescript
POST /activities
{
  type: "Call" | "SMS",
  note: "Include url to recording or body of text message",
  person_id: personId,
  done: true
}
```

---

## Phase 2: Module 1.2 (The AI Listener)

### Step 6: Integrate Gemini 2.5 Flash

**Goal:** Parse unstructured text into structured JSON.

**Install SDK:**
```bash
npm install @google/generative-ai
```

**Create Helper Service:** `lib/ai.ts`

> [!WARNING]
> **Replace Confidence Threshold with Structured Validation:** Gemini doesn't return confidence scores. Instead:
> 1. Use JSON mode for guaranteed valid JSON output
> 2. Validate that extracted fields are non-empty
> 3. Optionally ask the model to self-assess confidence
>
> ```typescript
> import { GoogleGenerativeAI } from '@google/generative-ai';
>
> const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY!);
>
> interface ExtractedEntity {
>   firstName: string | null;
>   lastName: string | null;
>   email: string | null;
>   address: string | null;
>   intent: 'Booking' | 'Inquiry' | 'Spam' | 'Unknown';
>   confidence: 'high' | 'medium' | 'low';
> }
>
> export async function extractEntities(messageBody: string): Promise<ExtractedEntity | null> {
>   // Skip very short messages to save API costs
>   if (messageBody.length < 10) return null;
>
>   const model = genAI.getGenerativeModel({
>     model: 'gemini-2.5-flash',
>     generationConfig: { responseMimeType: 'application/json' }
>   });
>
>   const prompt = `
> Analyze this message: "${messageBody}"
>
> Extract the following if present:
> - firstName: First name of the sender
> - lastName: Last name of the sender
> - email: Email address
> - address: Physical address
> - intent: One of "Booking", "Inquiry", "Spam", or "Unknown"
> - confidence: Your confidence in the extraction - "high", "medium", or "low"
>
> Return null for fields you cannot determine. Return valid JSON only.
> `;
>
>   try {
>     const result = await model.generateContent(prompt);
>     const text = result.response.text();
>     return JSON.parse(text) as ExtractedEntity;
>   } catch (error) {
>     console.error('AI extraction failed:', error);
>     return null; // Graceful degradation - just log activity without updating contact
>   }
> }
> ```

**Wire into Quo Webhook:**

Modify `api/webhooks/quo.ts`:

Inside the `message.received` block, before logging the activity:
1. Call `ai.extractEntities(messageBody)`
2. If result exists AND `confidence === 'high'`: Update the Pipedrive Person object (created in Step 5) with the extracted Name/Email

---

## Phase 3: Error Handling & Retry Strategy

> [!IMPORTANT]
> This section was added to address the "retry later" error handling preference. Implementing reliable webhook processing is critical for data consistency.

### Recommended: Upstash QStash for Webhook Retries

[Upstash QStash](https://upstash.com/docs/qstash) provides built-in retry logic and is designed for serverless environments.

**Setup:**
```bash
npm install @upstash/qstash
```

**Pattern: Queue Failed Operations**

```typescript
import { Client } from '@upstash/qstash';

const qstash = new Client({ token: process.env.QSTASH_TOKEN! });

async function processWebhook(event: WebhookEvent) {
  try {
    await syncToPipedrive(event);
  } catch (error) {
    // Queue for retry instead of failing silently
    await qstash.publishJSON({
      url: `${process.env.BASE_URL}/api/retry/pipedrive-sync`,
      body: event,
      retries: 3,
      delay: '5m' // Retry in 5 minutes
    });

    // Still return 200 to acknowledge webhook receipt
    console.error('Queued for retry:', error);
  }
}
```

### Idempotency Keys

Prevent duplicate processing when retries occur:

```typescript
import { Redis } from '@upstash/redis';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!
});

async function processIfNew(eventId: string, processor: () => Promise<void>) {
  const key = `dedupe:${eventId}`;

  // Try to set the key (NX = only if not exists, EX = expire in 24h)
  const isNew = await redis.set(key, 'processing', { nx: true, ex: 86400 });

  if (!isNew) {
    console.log(`Event ${eventId} already processed, skipping`);
    return;
  }

  try {
    await processor();
    await redis.set(key, 'completed', { ex: 86400 });
  } catch (error) {
    await redis.del(key); // Allow retry on failure
    throw error;
  }
}
```

---

## Phase 4: Testing Strategy

### Step 7: Testing

**Unit Tests:** Test the phone number normalizer (it fails often on weird inputs).

```typescript
// __tests__/phone.test.ts
import { normalizePhone } from '../lib/phone';

describe('normalizePhone', () => {
  it('converts US numbers to E.164', () => {
    expect(normalizePhone('(555) 123-4567')).toBe('+15551234567');
    expect(normalizePhone('555-123-4567')).toBe('+15551234567');
  });

  it('handles already-formatted numbers', () => {
    expect(normalizePhone('+15551234567')).toBe('+15551234567');
  });

  it('returns null for invalid numbers', () => {
    expect(normalizePhone('not a phone')).toBeNull();
    expect(normalizePhone('123')).toBeNull();
  });
});
```

**Integration Test Flow:**
1. Send a text "Hi, I'm John Doe" to your Quo number
2. **Expectation:**
   - Quo webhook fires
   - Middleware creates "Unknown Lead"
   - AI Listener parses "John Doe"
   - Middleware updates Person name to "John Doe"
   - Pipedrive webhook fires (update)
   - Middleware checks ID, sees it's the "System", and ignores it
3. **Result:** Clean data, no infinite loop

---

## Phase 5: Deployment

### Step 8: Go Live

1. Push code to GitHub Main
2. Vercel automatically builds/deploys
3. Configure Webhooks in Pipedrive & Quo Dashboards to point to production URLs
4. **Monitoring:** Check Vercel Logs for `Loop prevented` messages to confirm safety logic is working

### Pre-Launch Checklist

- [ ] All environment variables set in Vercel dashboard
- [ ] Webhook URLs registered in Pipedrive
- [ ] Webhook URLs registered in Quo/OpenPhone
- [ ] Redis database accessible from Vercel
- [ ] Test webhook received and processed successfully
- [ ] Loop prevention verified (create contact, check logs)

---

## Appendix: Environment Variables Reference

| Variable | Description | Required |
|----------|-------------|----------|
| `PIPEDRIVE_API_KEY` | Pipedrive API token | Yes |
| `PIPEDRIVE_COMPANY_DOMAIN` | Your Pipedrive subdomain | Yes |
| `PIPEDRIVE_USER_ID` | System bot user ID for loop prevention | Yes |
| `QUO_API_KEY` | Quo/OpenPhone API key | Yes |
| `QUO_WEBHOOK_SIGNING_SECRET` | Webhook signature secret | Yes |
| `GOOGLE_API_KEY` | Gemini API key | Yes |
| `UPSTASH_REDIS_REST_URL` | Redis connection URL | Yes |
| `UPSTASH_REDIS_REST_TOKEN` | Redis auth token | Yes |
| `QSTASH_TOKEN` | QStash token for retries | Recommended |
| `BASE_URL` | Production URL for retry endpoints | Yes |
