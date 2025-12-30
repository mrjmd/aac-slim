# Automated Testing Plan

This document outlines the strategy for adding lightweight automated tests to the AAC Middleware after manual verification is complete.

## Primary Goal

**Prevent regressions.** Once manual testing confirms everything works, automated tests lock in that behavior so future changes don't accidentally break things.

## Philosophy

- **Regression prevention, not comprehensive coverage**: Test the paths we know work
- **Simple and fast**: If a test is complex, it's probably not worth writing
- **Mock external APIs**: Never hit real Pipedrive/Quo/Gemini in tests
- **Run on every change**: Tests must complete in seconds

## Test Structure

```
tests/
├── unit/                    # Pure function tests (no mocking needed)
│   ├── phone.test.ts        # Phone normalization
│   ├── name-parser.test.ts  # Name splitting logic
│   └── gemini.test.ts       # Entity extraction parsing
│
├── integration/             # Tests with mocked external APIs
│   ├── quo-webhook.test.ts  # Quo webhook handler logic
│   ├── pipedrive-webhook.test.ts
│   └── google-ads-webhook.test.ts
│
└── mocks/                   # Shared mock implementations
    ├── pipedrive.ts
    ├── quo.ts
    ├── gemini.ts
    └── redis.ts
```

## Phase 1: Unit Tests (No Mocking)

These test pure functions with no external dependencies.

### 1.1 Phone Normalization (`src/lib/phone.ts`)

```typescript
// tests/unit/phone.test.ts
describe('normalizePhone', () => {
  it('normalizes US number with country code', () => {
    expect(normalizePhone('+1 (617) 555-1234')).toBe('+16175551234');
  });

  it('adds +1 to 10-digit US numbers', () => {
    expect(normalizePhone('6175551234')).toBe('+16175551234');
  });

  it('returns null for invalid numbers', () => {
    expect(normalizePhone('invalid')).toBeNull();
    expect(normalizePhone('123')).toBeNull();
  });

  it('handles international numbers', () => {
    expect(normalizePhone('+44 20 7946 0958')).toBe('+442079460958');
  });
});
```

### 1.2 Name Parsing (`src/clients/quo.ts`)

```typescript
// tests/unit/name-parser.test.ts
describe('parseFullName', () => {
  it('splits first and last name', () => {
    expect(parseFullName('John Smith')).toEqual({
      firstName: 'John',
      lastName: 'Smith'
    });
  });

  it('handles single name', () => {
    expect(parseFullName('Madonna')).toEqual({
      firstName: 'Madonna',
      lastName: null
    });
  });

  it('handles multiple middle names', () => {
    expect(parseFullName('John Robert Smith Jr')).toEqual({
      firstName: 'John',
      lastName: 'Robert Smith Jr'
    });
  });

  it('handles empty/whitespace', () => {
    expect(parseFullName('')).toEqual({ firstName: '', lastName: null });
    expect(parseFullName('  ')).toEqual({ firstName: '', lastName: null });
  });
});
```

### 1.3 Gemini Response Parsing

```typescript
// tests/unit/gemini.test.ts
describe('hasUsefulEntities', () => {
  it('returns true when name present', () => {
    expect(hasUsefulEntities({ firstName: 'John', lastName: null, ... })).toBe(true);
  });

  it('returns true when email present', () => {
    expect(hasUsefulEntities({ email: 'test@example.com', ... })).toBe(true);
  });

  it('returns false when only confidence present', () => {
    expect(hasUsefulEntities({ confidence: 'low', ... })).toBe(false);
  });

  it('returns false for null', () => {
    expect(hasUsefulEntities(null)).toBe(false);
  });
});
```

---

## Phase 2: Integration Tests (Mocked APIs)

These test webhook handlers with mocked external services.

### 2.1 Test Framework Setup

```bash
npm install --save-dev vitest @vitest/coverage-v8
```

```typescript
// vitest.config.ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    coverage: {
      reporter: ['text', 'html'],
      include: ['src/**/*.ts', 'api/**/*.ts'],
    },
  },
});
```

### 2.2 Mock Strategy

Create mock implementations that track calls and return predictable responses:

```typescript
// tests/mocks/pipedrive.ts
export const mockPipedrive = {
  calls: [] as Array<{ method: string; args: unknown[] }>,

  reset() {
    this.calls = [];
  },

  searchPersonByPhone: vi.fn().mockResolvedValue(null),
  createPerson: vi.fn().mockResolvedValue({ id: 12345, name: 'Test' }),
  updatePersonIncremental: vi.fn().mockResolvedValue({ updated: true, fields: ['name'] }),
  logActivity: vi.fn().mockResolvedValue({ id: 1 }),
};
```

### 2.3 Quo Webhook Tests

```typescript
// tests/integration/quo-webhook.test.ts
describe('Quo Webhook Handler', () => {
  beforeEach(() => {
    mockPipedrive.reset();
    mockRedis.reset();
    mockGemini.reset();
  });

  describe('message.received', () => {
    it('creates Unknown Lead for new phone number', async () => {
      mockPipedrive.searchPersonByPhone.mockResolvedValue(null);

      const response = await handleQuoWebhook(validMessagePayload);

      expect(response.status).toBe(200);
      expect(mockPipedrive.createPerson).toHaveBeenCalledWith(
        expect.stringContaining('Unknown Lead'),
        '+16175551234'
      );
    });

    it('logs activity for existing contact', async () => {
      mockPipedrive.searchPersonByPhone.mockResolvedValue({ id: 123, name: 'Existing' });

      const response = await handleQuoWebhook(validMessagePayload);

      expect(mockPipedrive.createPerson).not.toHaveBeenCalled();
      expect(mockPipedrive.logActivity).toHaveBeenCalledWith(123, 'sms', expect.any(Object));
    });

    it('extracts entities from message content', async () => {
      mockGemini.extractEntities.mockResolvedValue({
        firstName: 'John',
        lastName: 'Doe',
        email: null,
        confidence: 'high'
      });

      const response = await handleQuoWebhook(messageWithName);

      expect(mockPipedrive.updatePersonIncremental).toHaveBeenCalledWith(
        expect.any(Number),
        expect.objectContaining({ name: 'John Doe' })
      );
    });

    it('skips AI for short messages', async () => {
      const shortMessage = { ...validMessagePayload, data: { body: 'OK' } };

      await handleQuoWebhook(shortMessage);

      expect(mockGemini.extractEntities).not.toHaveBeenCalled();
    });

    it('skips AI for outbound messages', async () => {
      const outboundMessage = { ...validMessagePayload, type: 'message.delivered' };

      await handleQuoWebhook(outboundMessage);

      expect(mockGemini.extractEntities).not.toHaveBeenCalled();
    });
  });

  describe('deduplication', () => {
    it('ignores duplicate events', async () => {
      mockRedis.markEventProcessed.mockResolvedValue(false); // Already processed

      const response = await handleQuoWebhook(validMessagePayload);

      expect(response.body.status).toBe('ignored');
      expect(response.body.reason).toBe('duplicate');
    });
  });
});
```

### 2.4 Google Ads Webhook Tests

```typescript
// tests/integration/google-ads-webhook.test.ts
describe('Google Ads Webhook Handler', () => {
  it('rejects invalid google_key', async () => {
    const response = await handleGoogleAdsWebhook({
      ...validLeadPayload,
      google_key: 'wrong-key'
    });

    expect(response.status).toBe(401);
  });

  it('creates contact and sends SMS for new lead', async () => {
    mockPipedrive.searchPersonByPhone.mockResolvedValue(null);

    const response = await handleGoogleAdsWebhook(validLeadPayload);

    expect(mockPipedrive.createPerson).toHaveBeenCalled();
    expect(mockPipedrive.createTask).toHaveBeenCalled();
    expect(mockQuo.sendMessage).toHaveBeenCalled();
  });

  it('skips lead without phone number', async () => {
    const noPhoneLead = {
      ...validLeadPayload,
      user_column_data: [{ column_id: 'FULL_NAME', string_value: 'Test' }]
    };

    const response = await handleGoogleAdsWebhook(noPhoneLead);

    expect(response.body.status).toBe('skipped');
    expect(response.body.reason).toBe('no_phone');
  });
});
```

---

## Phase 3: End-to-End Tests (Optional)

For true E2E tests against staging/test environments with real APIs. Only run manually or in CI with proper credentials.

```typescript
// tests/e2e/full-flow.test.ts
describe.skip('E2E: Full sync flow', () => {
  // These require real API keys and should only run manually
  // Use a dedicated test Pipedrive/Quo account

  it('creates contact in Quo when added to Pipedrive', async () => {
    // 1. Create contact in Pipedrive via API
    // 2. Wait for webhook to process
    // 3. Verify contact exists in Quo
    // 4. Cleanup: delete from both
  });
});
```

---

## Implementation Order

After manual testing confirms everything works:

1. **Phase 1** (~1 hour): Unit tests for pure functions
   - Phone normalization, name parsing
   - No mocking needed, easy wins

2. **Phase 2** (~2 hours): One happy-path test per webhook
   - Quo webhook: inbound SMS creates contact + extracts entities
   - Pipedrive webhook: new contact syncs to Quo
   - Google Ads webhook: lead creates contact + sends SMS

3. **Phase 3** (if needed): Add tests when bugs are found
   - If a regression happens, write a test that would have caught it
   - Don't write tests speculatively

---

## CI/CD Integration

Add to `package.json`:

```json
{
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "test:coverage": "vitest run --coverage"
  }
}
```

Future: Add GitHub Actions workflow to run tests on PR.

---

## Success Criteria

Automated testing is "done" when:

- [ ] Tests run in <10 seconds
- [ ] Each webhook has at least one "happy path" test
- [ ] Key decision points are covered (e.g., "skip if no phone", "skip if outbound")
- [ ] Running `npm test` before deploy gives confidence nothing broke

Coverage percentage doesn't matter. If the tests catch regressions, they're doing their job.
