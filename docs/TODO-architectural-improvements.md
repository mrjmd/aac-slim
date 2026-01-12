# TODO: Architectural Improvements

> **Status:** Planned - Not Yet Started
> **Created:** January 10, 2026
> **Priority:** Next after current issues resolved

This document captures planned architectural improvements based on a comprehensive code review. Implementation is deferred pending resolution of current production issues.

---

## Summary

| Order | Priority | Item | Effort | Files |
|-------|----------|------|--------|-------|
| 1 | CRITICAL | Send Safety Layer | 1h | `send/route.ts` |
| 2 | HIGH | Dead Letter Queue | 1h | `send/route.ts`, `health/route.ts`, `health/page.tsx` |
| 3 | HIGH | Phone Normalization | 30m | `csv-parser.ts`, `suppression.ts`, `create/route.ts` |
| 4 | MEDIUM | Redis Key Standardization | 1h | New `redis-keys.ts`, update imports |
| 5 | MEDIUM | Smoke Test Endpoint | 1h | New `smoke-test/route.ts` |
| 6 | MEDIUM | Webhook Heartbeat | 30m | `health/route.ts`, `health/page.tsx` |

**Total Effort:** ~5.5 hours

---

## Priority 1: CRITICAL - Campaign Send Safety Layer

### Problem
The send route (`app/api/campaign/send/route.ts`) only checks opt-outs before sending. It does NOT check:
- DNC list (`suppression:dnc`)
- Litigators (`suppression:litigators`)
- Landlines (`suppression:landlines`)
- Inactive phones (`suppression:inactive`)

If someone is added to DNC AFTER scrubbing but BEFORE their queued message sends, they will receive the message.

### Solution
Add comprehensive suppression check before every send, BUT respect campaign settings (e.g., if `includeDnc=true`, skip DNC check).

### Files to Modify
- `app/api/campaign/send/route.ts` - Add `isBlocked()` function with campaign-aware suppression checks

### Implementation

```typescript
// New function in send/route.ts
interface CampaignSettings {
  includeDnc?: boolean  // If true, skip DNC check
}

async function isBlocked(
  phone: string,
  settings: CampaignSettings
): Promise<{ blocked: boolean; reason?: string }> {
  const redis = getRedis()
  const normalized = toRedisPhone(phone)
  if (!normalized) return { blocked: false }

  // Check each suppression list, respecting campaign settings
  const [isOptOut, isDnc, isLit, isLandline, isInactive] = await Promise.all([
    redis.sismember('optouts:phones', normalized),
    settings.includeDnc ? 0 : redis.sismember('suppression:dnc', normalized),
    redis.sismember('suppression:litigators', normalized),
    redis.sismember('suppression:landlines', normalized),
    redis.hget('suppression:inactive', normalized),
  ])

  if (isLit === 1) return { blocked: true, reason: 'litigator' }
  if (isDnc === 1) return { blocked: true, reason: 'dnc' }
  if (isOptOut === 1) return { blocked: true, reason: 'optout' }
  if (isLandline === 1) return { blocked: true, reason: 'landline' }
  if (isInactive) return { blocked: true, reason: 'inactive' }

  return { blocked: false }
}
```

---

## Priority 2: HIGH - Dead Letter Queue

### Problem
Failed messages return HTTP 200 (to prevent QStash retries) but are lost. No way to retry or audit.

### Solution
Store failed messages in Redis list for manual retry via dashboard.

### Files to Modify
- `app/api/campaign/send/route.ts` - Add DLQ storage on failure
- `app/api/health/route.ts` - Add failed message count to health metrics
- `app/health/page.tsx` - Add "Failed Messages" section to dashboard

### Implementation

```typescript
// In send/route.ts
async function logFailedMessage(payload: SendPayload, error: string) {
  const redis = getRedis()
  const entry = JSON.stringify({
    ...payload,
    failedAt: new Date().toISOString(),
    error,
  })
  await redis.lpush('campaign:failed-messages', entry)
  await redis.ltrim('campaign:failed-messages', 0, 999) // Keep last 1000
}
```

---

## Priority 3: HIGH - Phone Normalization Consolidation

### Problem
There are **4 duplicate `normalizePhone` functions** in the codebase:
- `src/lib/phone.ts:29` - Canonical (correct)
- `src/lib/csv-parser.ts:97` - **LOCAL DUPLICATE**
- `app/lib/suppression.ts:39` - **LOCAL DUPLICATE**
- `app/api/campaign/create/route.ts:72` - **LOCAL DUPLICATE**

This is a data integrity risk - different functions could normalize phones differently.

### Solution
Remove all local duplicates and import from canonical `src/lib/phone.ts`.

### Canonical Functions Available
| Function | Format | Use Case |
|----------|--------|----------|
| `normalizePhone(phone)` | E.164 (+14155551234) | API calls |
| `toRedisPhone(phone)` | 10-digit (4155551234) | Redis keys |
| `quickNormalizePhone(phone)` | E.164 (fast) | Validation |
| `phonesMatch(a, b)` | Boolean | Comparison |

---

## Priority 4: MEDIUM - Redis Key Standardization

### Problem
Redis keys defined in TWO places:
- `src/lib/redis.ts` - Functions: `KEYS.dncPhones()`
- `app/lib/suppression.ts` - Strings: `KEYS.dncPhones`

### Solution
Create `src/lib/redis-keys.ts` as single source of truth.

---

## Priority 5: MEDIUM - Smoke Test Endpoint

### Problem
Health dashboard shows stats but doesn't proactively verify connectivity.

### Solution
Create `/api/health/smoke-test` endpoint that tests Redis, Pipedrive, and OpenPhone connectivity.

---

## Priority 6: MEDIUM - Webhook Heartbeat Alerting

### Problem
If Pipedrive disconnects the webhook, there's no automatic alert.

### Solution
Track last webhook timestamp and alert if stale (>24h).

---

## DEFERRED: Quo Webhook Race Condition

### Problem
Two rapid texts from new number can both create "Unknown Lead" contacts before either finishes, causing duplicates.

### Why Deferred
- Duplicates are rare and can be merged manually in Pipedrive
- Fix requires distributed locking which adds complexity
- Current priority is on safety-critical items

### Future Solution
Add Redis lock before contact creation.

---

## Verification Steps

After implementation:

1. **Safety Layer**: Test DNC blocking with `includeDnc=false` and bypass with `includeDnc=true`
2. **Dead Letter Queue**: Simulate failure, verify storage and retry
3. **Phone Normalization**: Verify single function via grep
4. **Smoke Test**: Call endpoint, verify 503 on failure
5. **Webhook Heartbeat**: Verify 24h stale warning

---

## Related Documentation

- [Module 3: Campaign Manager Spec](./module-3-campaign-manager-spec.md)
- [Campaign Manual Testing](./manual-testing/module-3-campaign.md)
- [Automated Testing](./automated-testing/README.md)
