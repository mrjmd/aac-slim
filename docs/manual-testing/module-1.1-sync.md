# Module 1.1: Pipedrive ↔ Quo Bidirectional Sync

## Overview

This module syncs contacts between Pipedrive and Quo (OpenPhone) in both directions:
- **Pipedrive → Quo**: When a contact is added/updated in Pipedrive, sync to Quo
- **Quo → Pipedrive**: When a call/SMS is received from unknown number, create contact in Pipedrive

---

## Test 1.1.1: Pipedrive → Quo (New Contact)

**Goal**: Verify that creating a contact in Pipedrive automatically creates it in Quo.

### Steps

1. **Open Pipedrive** and go to Contacts → People
2. **Create a new person** with:
   - Name: `Test Sync User`
   - Phone: A real phone number you control (E.164 format: `+1XXXXXXXXXX`)
   - Organization: `Test Company` (create if needed)
3. **Wait 5-10 seconds** for webhook to process
4. **Open Quo/OpenPhone** and search for the phone number

### Expected Results

- [ ] Contact appears in Quo with name "Test Sync User"
- [ ] First name / Last name are properly split
- [ ] Company shows "Test Company"
- [ ] Phone number matches

### Cleanup

- Delete the test contact from Pipedrive
- Delete the test contact from Quo

---

## Test 1.1.2: Pipedrive → Quo (Update Contact)

**Goal**: Verify that updating a contact in Pipedrive syncs changes to Quo.

### Prerequisites

- Complete Test 1.1.1 first, or have an existing synced contact

### Steps

1. **In Pipedrive**, find the test contact
2. **Update the contact**:
   - Change name to `Updated Test User`
   - Add/change Job Title to `Sales Manager`
3. **Wait 5-10 seconds** for webhook to process
4. **In Quo**, search for the contact

### Expected Results

- [ ] Name updated to "Updated Test User"
- [ ] Job title shows "Sales Manager" (in Role field)

### Cleanup

- Delete the test contact from both systems

---

## Test 1.1.3: Quo → Pipedrive (Inbound Call)

**Goal**: Verify that receiving a call from an unknown number creates a Pipedrive contact.

### Steps

1. **From a phone not in either system**, call your Quo phone number
2. **Let it ring** for a few seconds, then hang up (or leave a voicemail)
3. **Wait 10-15 seconds** for webhook to process
4. **In Pipedrive**, search for the phone number

### Expected Results

- [ ] Contact created with name "Unknown Lead +1XXXXXXXXXX"
- [ ] Phone number correctly stored
- [ ] Call activity logged on the contact

### Cleanup

- Note the contact ID for use in later tests, or delete if not needed

---

## Test 1.1.4: Quo → Pipedrive (Inbound SMS)

**Goal**: Verify that receiving an SMS from an unknown number creates a Pipedrive contact.

### Steps

1. **From a phone not in either system**, send an SMS to your Quo phone number
   - Message: `Hello, this is a test message`
2. **Wait 10-15 seconds** for webhook to process
3. **In Pipedrive**, search for the phone number

### Expected Results

- [ ] Contact created with name "Unknown Lead +1XXXXXXXXXX"
- [ ] Phone number correctly stored
- [ ] SMS activity logged on the contact with message content

### Cleanup

- Note the contact ID for use in Module 1.3 tests

---

## Test 1.1.5: Full Round-Trip Sync

**Goal**: Verify the complete bidirectional flow works without loops.

### Steps

1. **From an unknown phone**, send SMS to your Quo number: `Hi there`
2. **Wait 15 seconds**
3. **In Pipedrive**, find the new "Unknown Lead" contact
4. **Update the name** to `Round Trip Test`
5. **Wait 10 seconds**
6. **In Quo**, search for the phone number

### Expected Results

- [ ] Pipedrive contact created from SMS
- [ ] SMS activity logged in Pipedrive
- [ ] After name update, Quo contact shows "Round Trip Test"
- [ ] No duplicate contacts in either system
- [ ] No errors in logs

### Cleanup

- Delete from both systems

---

## Troubleshooting

### Contact not syncing to Quo

1. Check Vercel logs: `npx vercel logs https://aac-middleware.vercel.app --follow`
2. Verify Pipedrive webhook is active and pointing to correct URL
3. Confirm phone number is in valid E.164 format

### Contact not created in Pipedrive from call/SMS

1. Check Vercel logs for Quo webhook events
2. Verify Quo webhook is configured with correct secret
3. Check that the signature header is being sent

### Duplicate contacts

1. This shouldn't happen - both webhooks search before creating
2. If it does, check for race conditions in logs
3. May need to increase Redis TTL for deduplication
