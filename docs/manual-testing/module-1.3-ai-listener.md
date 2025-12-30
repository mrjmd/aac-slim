# Module 1.3: AI Listener (Entity Extraction)

## Overview

This module uses Gemini 2.0 Flash to extract contact information from inbound SMS messages and call transcripts, then incrementally updates Pipedrive contacts.

**What it extracts:**
- First name / Last name / Full name
- Email address
- Street address, City, State, ZIP

**Smart rules:**
- Only processes inbound messages (not outbound)
- Skips messages under 10 characters
- Only updates "Unknown Lead" names (preserves known names)
- Only adds email if none exists (never overwrites)
- Syncs extracted data to both Pipedrive AND Quo

---

## Test 1.3.1: Name Extraction from SMS

**Goal**: Verify that a name mentioned in an SMS is extracted and saved.

### Prerequisites

- `GEMINI_API_KEY` set in Vercel
- A phone not currently in Pipedrive or Quo

### Steps

1. **From an unknown phone**, send SMS to your Quo number:
   ```
   Hi, my name is John Smith. I'm interested in your services.
   ```
2. **Wait 15-20 seconds** for processing (includes AI call)
3. **Check Pipedrive** for the contact

### Expected Results

- [ ] Contact created (initially as "Unknown Lead +1XXX...")
- [ ] Name updated to "John Smith" (from AI extraction)
- [ ] SMS activity logged with full message
- [ ] Vercel logs show "AI extracted and updated contact"

4. **Check Quo** for the contact

### Expected Results

- [ ] Contact exists with name "John Smith"
- [ ] Sync happened via Pipedrive webhook (not duplicate creation)

### Cleanup

- Keep contact for next test, or delete from both systems

---

## Test 1.3.2: Email Extraction

**Goal**: Verify that an email mentioned in an SMS is extracted and saved.

### Prerequisites

- An "Unknown Lead" contact in Pipedrive (from Test 1.3.1 or fresh)

### Steps

1. **From the same phone** used in 1.3.1, send SMS:
   ```
   You can reach me at johnsmith@example.com
   ```
2. **Wait 15-20 seconds**
3. **Check Pipedrive** contact

### Expected Results

- [ ] Email field now shows `johnsmith@example.com`
- [ ] Name unchanged (already set)
- [ ] Vercel logs show email was extracted

---

## Test 1.3.3: Address Extraction

**Goal**: Verify that a full address is extracted and saved to Pipedrive.

### Steps

1. **From an unknown phone**, send SMS:
   ```
   Hi, I'm Jane Doe. My address is 123 Main Street, Boston, MA 02101
   ```
2. **Wait 15-20 seconds**
3. **Check Pipedrive** contact → Personal address field

### Expected Results

- [ ] Contact created with name "Jane Doe"
- [ ] Personal address field populated:
  - Street: 123 Main Street
  - City: Boston
  - State: MA
  - ZIP: 02101

### Cleanup

- Delete contact

---

## Test 1.3.4: Incremental Data (Multiple Messages)

**Goal**: Verify that data accumulates across multiple messages without overwriting.

### Steps

1. **Send first SMS** from unknown phone:
   ```
   Hi, this is Mike
   ```
2. **Wait 20 seconds**, then **send second SMS**:
   ```
   My last name is Johnson
   ```
3. **Wait 20 seconds**, then **send third SMS**:
   ```
   Email me at mike.johnson@gmail.com
   ```
4. **Check Pipedrive** after each message

### Expected Results

After message 1:
- [ ] Contact created as "Mike" (first name only)

After message 2:
- [ ] Name updated to "Mike Johnson"

After message 3:
- [ ] Email added: `mike.johnson@gmail.com`
- [ ] Name still "Mike Johnson" (not overwritten)

---

## Test 1.3.5: Skip Outbound Messages

**Goal**: Verify that outbound SMS are not processed for extraction.

### Steps

1. **From Quo**, send an outbound SMS to any number:
   ```
   Hi, this is Matt from AAC. My email is matt@aac.com
   ```
2. **Wait 10 seconds**
3. **Check Vercel logs**

### Expected Results

- [ ] Message logged as activity in Pipedrive
- [ ] NO AI extraction attempted (logs show no Gemini call)
- [ ] Contact not updated with "Matt" name

---

## Test 1.3.6: Skip Trivial Messages

**Goal**: Verify that very short messages are not sent to AI.

### Steps

1. **From a known contact's phone**, send SMS:
   ```
   OK
   ```
2. **Check Vercel logs**

### Expected Results

- [ ] SMS activity logged in Pipedrive
- [ ] NO AI extraction (message under 10 chars)
- [ ] No Gemini API call in logs

---

## Test 1.3.7: Preserve Known Contact Names

**Goal**: Verify that AI doesn't overwrite names on established contacts.

### Steps

1. **Create a Pipedrive contact** manually:
   - Name: `Established Customer`
   - Phone: A phone you control
2. **Wait for sync to Quo**
3. **From that phone**, send SMS:
   ```
   Hi, this is Bob Wilson calling about my project
   ```
4. **Check Pipedrive contact**

### Expected Results

- [ ] Name still "Established Customer" (NOT changed to "Bob Wilson")
- [ ] SMS logged as activity
- [ ] Logs show "No incremental updates needed" (name preserved)

---

## Test 1.3.8: Full Flow - Unknown to Known

**Goal**: Test the complete journey from unknown caller to fully populated contact.

### Steps

1. **From a brand new phone**, call your Quo number, let it ring, hang up
2. **Wait 15 seconds** - contact created as "Unknown Lead"
3. **Check Pipedrive** - confirm Unknown Lead exists
4. **Send SMS from same phone**:
   ```
   Hi, this is Sarah Miller. I was just trying to call about getting an estimate. My email is sarah.miller@company.com and I'm at 456 Oak Avenue, Cambridge, MA 02139.
   ```
5. **Wait 20 seconds**
6. **Check Pipedrive contact**
7. **Check Quo contact**

### Expected Results

Pipedrive:
- [ ] Name: "Sarah Miller"
- [ ] Phone: Correct number
- [ ] Email: `sarah.miller@company.com`
- [ ] Personal address: 456 Oak Avenue, Cambridge, MA 02139
- [ ] Activities: Call + SMS logged

Quo:
- [ ] Name: "Sarah Miller"
- [ ] Phone matches

---

## Troubleshooting

### AI extraction not working

1. Verify `GEMINI_API_KEY` is set in Vercel
2. Check logs for Gemini API errors
3. Confirm message is >10 characters and inbound

### Name not updating

1. Check if contact name starts with "Unknown Lead" - only those get updated
2. Look for "No incremental updates needed" in logs

### Address not saving

1. Verify the Pipedrive custom field key matches: `5fc7cf5d8c890fe2f7062aaabe1e9b416c851511`
2. Check Pipedrive API response in logs for field errors

### Data not syncing to Quo

1. Pipedrive webhook should fire after update
2. Check logs for Pipedrive webhook processing
3. Verify Quo contact search/update in logs
