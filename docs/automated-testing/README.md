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
│   ├── gemini.test.ts       # Entity extraction parsing
│   ├── report-generator.test.ts  # Commission report formatting
│   └── attribution.test.ts  # Commission calculation
│
├── integration/             # Tests with mocked external APIs
│   ├── quo-webhook.test.ts  # Quo webhook handler logic
│   ├── pipedrive-webhook.test.ts
│   ├── google-ads-webhook.test.ts
│   ├── quickbooks.test.ts   # QuickBooks OAuth & customer sync
│   └── attribution.test.ts  # Full attribution flow
│
└── mocks/                   # Shared mock implementations
    ├── pipedrive.ts
    ├── quo.ts
    ├── gemini.ts
    ├── quickbooks.ts
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

### 1.4 Commission Calculation (`src/lib/attribution.ts`)

```typescript
// tests/unit/attribution.test.ts
describe('isCommissionedSalesRep', () => {
  it('returns true for configured salesperson', () => {
    expect(isCommissionedSalesRep(24313124)).toBe(true); // Edward Crowell
  });

  it('returns false for non-configured user', () => {
    expect(isCommissionedSalesRep(99999)).toBe(false);
  });

  it('returns false for owner (not a salesperson)', () => {
    expect(isCommissionedSalesRep(24313113)).toBe(false); // Matt Davis
  });
});

describe('getCommissionRate', () => {
  it('returns configured rate for salesperson', () => {
    expect(getCommissionRate(24313124)).toBe(0.20);
  });

  it('returns 0 for non-configured user', () => {
    expect(getCommissionRate(99999)).toBe(0);
  });
});
```

### 1.5 Report Generation (`src/lib/report-generator.ts`)

```typescript
// tests/unit/report-generator.test.ts
describe('generateSmsSummary', () => {
  it('returns no commissions message when results empty', () => {
    const data = { startDate: '2025-12-01', endDate: '2025-12-31', results: [] };
    expect(generateSmsSummary(data)).toBe('Dec commissions: No commissions owed.');
  });

  it('generates compact summary for single salesperson', () => {
    const data = {
      startDate: '2025-12-01',
      endDate: '2025-12-31',
      results: [
        { salesRepId: 1, salesRepName: 'Ed Crowell', commissionAmount: 1000, invoiceAmount: 5000, ... },
        { salesRepId: 1, salesRepName: 'Ed Crowell', commissionAmount: 500, invoiceAmount: 2500, ... },
      ]
    };
    expect(generateSmsSummary(data)).toBe('Dec commissions: Ed $1,500 (2 jobs)');
  });

  it('stays under 160 characters', () => {
    // Test with multiple salespeople
    const data = { ... };
    expect(generateSmsSummary(data).length).toBeLessThanOrEqual(160);
  });
});

describe('generateHtmlReport', () => {
  it('shows no commissions message when results empty', () => {
    const data = { startDate: '2025-12-01', endDate: '2025-12-31', results: [] };
    const html = generateHtmlReport(data);
    expect(html).toContain('No commissions owed in this period');
  });

  it('includes period in header', () => {
    const data = { startDate: '2025-12-01', endDate: '2025-12-31', results: [] };
    const html = generateHtmlReport(data);
    expect(html).toContain('Dec 1, 2025 - Dec 31, 2025');
  });

  it('generates table for results', () => {
    const data = {
      startDate: '2025-12-01',
      endDate: '2025-12-31',
      results: [{
        invoiceNumber: '1234',
        customerName: 'John Doe',
        invoiceDate: '2025-12-15',
        invoiceAmount: 5000,
        commissionAmount: 1000,
        salesRepId: 1,
        salesRepName: 'Ed Crowell',
        commissionRate: 0.20,
        ...
      }]
    };
    const html = generateHtmlReport(data);
    expect(html).toContain('1234'); // Invoice number
    expect(html).toContain('John Doe'); // Customer
    expect(html).toContain('$5,000.00'); // Amount
    expect(html).toContain('$1,000.00'); // Commission
    expect(html).toContain('Ed Crowell'); // Sales rep
  });
});

describe('generateJsonSummary', () => {
  it('calculates totals correctly', () => {
    const data = {
      startDate: '2025-12-01',
      endDate: '2025-12-31',
      results: [
        { invoiceAmount: 5000, commissionAmount: 1000, salesRepId: 1, salesRepName: 'Ed', commissionRate: 0.2, ... },
        { invoiceAmount: 2500, commissionAmount: 500, salesRepId: 1, salesRepName: 'Ed', commissionRate: 0.2, ... },
      ]
    };
    const summary = generateJsonSummary(data);
    expect(summary.totalInvoiceCount).toBe(2);
    expect(summary.totalInvoiceAmount).toBe(7500);
    expect(summary.totalCommission).toBe(1500);
  });

  it('groups by salesperson', () => {
    const data = {
      startDate: '2025-12-01',
      endDate: '2025-12-31',
      results: [
        { salesRepId: 1, salesRepName: 'Ed', invoiceAmount: 5000, commissionAmount: 1000, ... },
        { salesRepId: 2, salesRepName: 'Jane', invoiceAmount: 3000, commissionAmount: 450, ... },
      ]
    };
    const summary = generateJsonSummary(data);
    expect(summary.summaries).toHaveLength(2);
    expect(summary.summaries[0].salesRepName).toBe('Ed');
    expect(summary.summaries[1].salesRepName).toBe('Jane');
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

### 2.5 QuickBooks Integration Tests

```typescript
// tests/integration/quickbooks.test.ts
describe('QuickBooks Integration', () => {
  beforeEach(() => {
    mockQuickBooks.reset();
    mockRedis.reset();
  });

  describe('OAuth Token Management', () => {
    it('stores tokens correctly via storeQBTokens', async () => {
      const tokens = {
        accessToken: 'access123',
        refreshToken: 'refresh456',
        expiresAt: Date.now() + 3600000,
        refreshTokenExpiresAt: Date.now() + 8726400000,
      };

      await storeQBTokens(tokens);

      expect(mockRedis.set).toHaveBeenCalledWith(
        'oauth:quickbooks:tokens',
        tokens
      );
    });

    it('retrieves tokens correctly via getQBTokens', async () => {
      const storedTokens = {
        accessToken: 'access123',
        refreshToken: 'refresh456',
        expiresAt: Date.now() + 3600000,
        refreshTokenExpiresAt: Date.now() + 8726400000,
      };
      mockRedis.get.mockResolvedValue(storedTokens);

      const tokens = await getQBTokens();

      expect(tokens).toEqual(storedTokens);
    });

    it('returns null when no tokens stored', async () => {
      mockRedis.get.mockResolvedValue(null);

      const tokens = await getQBTokens();

      expect(tokens).toBeNull();
    });
  });

  describe('isQuickBooksConnected', () => {
    it('returns true when valid tokens exist', async () => {
      mockRedis.get.mockResolvedValue({
        accessToken: 'valid',
        expiresAt: Date.now() + 3600000,
        refreshTokenExpiresAt: Date.now() + 8726400000,
      });

      const connected = await isQuickBooksConnected();

      expect(connected).toBe(true);
    });

    it('returns false when no tokens', async () => {
      mockRedis.get.mockResolvedValue(null);

      const connected = await isQuickBooksConnected();

      expect(connected).toBe(false);
    });
  });

  describe('Customer Creation', () => {
    it('creates customer with all fields', async () => {
      mockQuickBooks.createCustomer.mockResolvedValue({ Id: '123' });

      const customer = await createCustomer({
        displayName: 'John Doe',
        firstName: 'John',
        lastName: 'Doe',
        email: 'john@example.com',
        phone: '+16175551234',
      });

      expect(customer.Id).toBe('123');
      expect(mockQuickBooks.createCustomer).toHaveBeenCalledWith(
        expect.objectContaining({
          DisplayName: 'John Doe',
          GivenName: 'John',
          FamilyName: 'Doe',
        })
      );
    });
  });

  describe('Pipedrive Webhook → QuickBooks', () => {
    it('creates QB customer when contact added to Pipedrive', async () => {
      mockRedis.get.mockImplementation((key) => {
        if (key === 'oauth:quickbooks:tokens') {
          return { accessToken: 'valid', expiresAt: Date.now() + 3600000 };
        }
        return null; // No existing mapping
      });
      mockQuickBooks.searchCustomerByEmail.mockResolvedValue(null);
      mockQuickBooks.createCustomer.mockResolvedValue({ Id: '456' });

      const response = await handlePipedriveWebhook(validPersonPayload);

      expect(mockQuickBooks.createCustomer).toHaveBeenCalled();
      expect(response.body.qbCustomerId).toBe('456');
    });

    it('skips QB sync when not connected', async () => {
      mockRedis.get.mockResolvedValue(null); // No tokens

      const response = await handlePipedriveWebhook(validPersonPayload);

      expect(mockQuickBooks.createCustomer).not.toHaveBeenCalled();
      expect(response.body.qbCustomerId).toBeNull();
    });

    it('links existing QB customer by email', async () => {
      mockRedis.get.mockImplementation((key) => {
        if (key === 'oauth:quickbooks:tokens') {
          return { accessToken: 'valid', expiresAt: Date.now() + 3600000 };
        }
        return null;
      });
      mockQuickBooks.searchCustomerByEmail.mockResolvedValue({ Id: '789' });

      const response = await handlePipedriveWebhook(validPersonPayload);

      expect(mockQuickBooks.createCustomer).not.toHaveBeenCalled();
      expect(response.body.qbCustomerId).toBe('789');
    });
  });
});
```

### 2.6 Attribution Engine Tests

```typescript
// tests/integration/attribution.test.ts
describe('Attribution Engine', () => {
  beforeEach(() => {
    mockQuickBooks.reset();
    mockPipedrive.reset();
    mockRedis.reset();
  });

  describe('runAttribution', () => {
    it('fetches paid invoices from QuickBooks', async () => {
      mockQuickBooks.getPaidInvoices.mockResolvedValue([]);

      await runAttribution('2025-12-01', '2025-12-31');

      expect(mockQuickBooks.getPaidInvoices).toHaveBeenCalledWith('2025-12-01', '2025-12-31');
    });

    it('skips invoices without QB→PD mapping', async () => {
      mockQuickBooks.getPaidInvoices.mockResolvedValue([
        { Id: '123', CustomerRef: { value: '456', name: 'Test' }, TotalAmt: 1000, Balance: 0 }
      ]);
      mockRedis.getPipedriveIdFromQb.mockResolvedValue(null);

      const result = await runAttribution('2025-12-01', '2025-12-31');

      expect(result.unattributed).toHaveLength(1);
      expect(result.unattributed[0].reason).toContain('No Pipedrive mapping');
    });

    it('skips invoices where owner is not commissioned', async () => {
      mockQuickBooks.getPaidInvoices.mockResolvedValue([
        { Id: '123', CustomerRef: { value: '456', name: 'Test' }, TotalAmt: 1000, Balance: 0, TxnDate: '2025-12-15' }
      ]);
      mockRedis.getPipedriveIdFromQb.mockResolvedValue('789');
      mockPipedrive.getPerson.mockResolvedValue({
        id: 789,
        name: 'Test Customer',
        owner_id: { id: 99999, name: 'Non-Commissioned User' } // Not in COMMISSION_RATES
      });
      mockPipedrive.getPersonReferredBy.mockResolvedValue(null);

      const result = await runAttribution('2025-12-01', '2025-12-31');

      expect(result.attributed).toBe(0);
    });

    it('calculates commission for commissioned salesperson', async () => {
      mockQuickBooks.getPaidInvoices.mockResolvedValue([
        { Id: '123', CustomerRef: { value: '456', name: 'Test' }, TotalAmt: 5000, Balance: 0, TxnDate: '2025-12-15' }
      ]);
      mockRedis.getPipedriveIdFromQb.mockResolvedValue('789');
      mockPipedrive.getPerson.mockResolvedValue({
        id: 789,
        name: 'Test Customer',
        owner_id: { id: 24313124, name: 'Edward Crowell' } // Commissioned at 20%
      });
      mockPipedrive.getPersonReferredBy.mockResolvedValue(null);
      mockPipedrive.getPipedriveUser.mockResolvedValue({ id: 24313124, name: 'Edward Crowell' });

      const result = await runAttribution('2025-12-01', '2025-12-31');

      expect(result.attributed).toBe(1);
      expect(result.results[0].commissionAmount).toBe(1000); // 5000 * 0.20
      expect(result.results[0].salesRepName).toBe('Edward Crowell');
    });

    it('traverses referral chain to find salesperson', async () => {
      mockQuickBooks.getPaidInvoices.mockResolvedValue([
        { Id: '123', CustomerRef: { value: '456', name: 'Customer' }, TotalAmt: 5000, Balance: 0, TxnDate: '2025-12-15' }
      ]);
      mockRedis.getPipedriveIdFromQb.mockResolvedValue('100'); // Customer

      // Customer → referred by Agent → referred by Salesperson
      mockPipedrive.getPersonReferredBy
        .mockResolvedValueOnce(200) // Customer referred by Agent
        .mockResolvedValueOnce(300) // Agent referred by Salesperson
        .mockResolvedValueOnce(null); // Salesperson has no referrer

      mockPipedrive.getPerson.mockResolvedValue({
        id: 300,
        name: 'Top of Chain',
        owner_id: { id: 24313124, name: 'Edward Crowell' }
      });
      mockPipedrive.getPipedriveUser.mockResolvedValue({ id: 24313124, name: 'Edward Crowell' });

      const result = await runAttribution('2025-12-01', '2025-12-31');

      expect(result.results[0].referralChain).toEqual([100, 200, 300]);
      expect(result.results[0].salesRepName).toBe('Edward Crowell');
    });

    it('detects circular referral chains', async () => {
      mockQuickBooks.getPaidInvoices.mockResolvedValue([
        { Id: '123', CustomerRef: { value: '456', name: 'Customer' }, TotalAmt: 5000, Balance: 0, TxnDate: '2025-12-15' }
      ]);
      mockRedis.getPipedriveIdFromQb.mockResolvedValue('100');

      // Circular: 100 → 200 → 100
      mockPipedrive.getPersonReferredBy
        .mockResolvedValueOnce(200)
        .mockResolvedValueOnce(100); // Back to start!

      const result = await runAttribution('2025-12-01', '2025-12-31');

      // Should handle gracefully, not infinite loop
      expect(result.errors).toBe(0);
    });

    it('skips already-processed invoices unless reprocess=true', async () => {
      mockQuickBooks.getPaidInvoices.mockResolvedValue([
        { Id: '123', CustomerRef: { value: '456', name: 'Test' }, TotalAmt: 5000, Balance: 0 }
      ]);
      mockRedis.wasInvoiceAttributed.mockResolvedValue(true);

      const result = await runAttribution('2025-12-01', '2025-12-31');
      expect(result.skipped).toBe(1);

      const resultReprocess = await runAttribution('2025-12-01', '2025-12-31', { reprocess: true });
      expect(resultReprocess.skipped).toBe(0);
    });
  });

  describe('Commission Report Endpoint', () => {
    it('returns 400 for missing date parameters', async () => {
      const response = await request(app).get('/api/reports/commissions');
      expect(response.status).toBe(400);
      expect(response.body.error).toContain('Missing required parameters');
    });

    it('returns 400 for invalid date format', async () => {
      const response = await request(app).get('/api/reports/commissions?startDate=invalid&endDate=2025-12-31');
      expect(response.status).toBe(400);
      expect(response.body.error).toContain('Invalid date format');
    });

    it('returns HTML by default', async () => {
      mockRedis.getAttributionsByDateRange.mockResolvedValue([]);

      const response = await request(app).get('/api/reports/commissions?startDate=2025-12-01&endDate=2025-12-31');

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toContain('text/html');
      expect(response.text).toContain('AAC Commission Report');
    });

    it('returns JSON when format=json', async () => {
      mockRedis.getAttributionsByDateRange.mockResolvedValue([]);

      const response = await request(app).get('/api/reports/commissions?startDate=2025-12-01&endDate=2025-12-31&format=json');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.report).toBeDefined();
    });

    it('filters out non-commissioned salespeople from results', async () => {
      mockRedis.getAttributionsByDateRange.mockResolvedValue([
        { salesRepId: 24313124, salesRepName: 'Edward Crowell', commissionAmount: 1000, ... }, // Commissioned
        { salesRepId: 99999, salesRepName: 'Other User', commissionAmount: 500, ... }, // Not commissioned
      ]);

      const response = await request(app).get('/api/reports/commissions?startDate=2025-12-01&endDate=2025-12-31&format=json');

      expect(response.body.report.results).toHaveLength(1);
      expect(response.body.report.results[0].salesRepName).toBe('Edward Crowell');
    });

    it('sends SMS when sendSms=true', async () => {
      mockRedis.getAttributionsByDateRange.mockResolvedValue([]);
      mockQuo.sendMessage.mockResolvedValue({ id: 'msg123' });

      await request(app).get('/api/reports/commissions?startDate=2025-12-01&endDate=2025-12-31&sendSms=true');

      expect(mockQuo.sendMessage).toHaveBeenCalled();
    });
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

---

## Module 3: Campaign Manager Tests

### Unit Tests

```typescript
// tests/unit/csv-parser.test.ts
describe('CSV Parser', () => {
  describe('normalizeName', () => {
    it('title-cases all-caps names', () => {
      expect(normalizeName('JON LINKER')).toEqual({
        firstName: 'Jon',
        lastName: 'Linker'
      });
    });

    it('handles single name', () => {
      expect(normalizeName('MADONNA')).toEqual({
        firstName: 'Madonna',
        lastName: null
      });
    });

    it('returns Homeowner for empty name', () => {
      expect(normalizeName('')).toEqual({
        firstName: 'Homeowner',
        lastName: null
      });
    });
  });

  describe('normalizePhone', () => {
    it('converts 10-digit to E.164', () => {
      expect(normalizePhone('339-222-4624')).toBe('+13392224624');
    });

    it('handles various formats', () => {
      expect(normalizePhone('(339) 222-4624')).toBe('+13392224624');
      expect(normalizePhone('3392224624')).toBe('+13392224624');
      expect(normalizePhone('1-339-222-4624')).toBe('+13392224624');
    });

    it('returns null for invalid numbers', () => {
      expect(normalizePhone('123')).toBeNull();
      expect(normalizePhone('invalid')).toBeNull();
    });
  });

  describe('parsePropertyRadarCSV', () => {
    it('parses valid CSV and extracts contacts', () => {
      const csv = `Primary Name,Primary Mobile Phone1,Primary Mobile 1 Status,City
JON LINKER,339-222-4624,Active,BRAINTREE`;

      const result = parsePropertyRadarCSV(csv);

      expect(result.contacts).toHaveLength(1);
      expect(result.contacts[0].firstName).toBe('Jon');
      expect(result.contacts[0].phone).toBe('+13392224624');
    });

    it('skips rows with inactive phone status', () => {
      const csv = `Primary Name,Primary Mobile Phone1,Primary Mobile 1 Status,City
JON LINKER,339-222-4624,Inactive,BRAINTREE`;

      const result = parsePropertyRadarCSV(csv);

      expect(result.contacts).toHaveLength(0);
      expect(result.stats.skippedInactivePhone).toBe(1);
    });

    it('extracts secondary contacts', () => {
      const csv = `Primary Name,Primary Mobile Phone1,Primary Mobile 1 Status,City,Secondary Name,Secondary Mobile Phone1
JON LINKER,339-222-4624,Active,BRAINTREE,AIMEE LINKER,781-316-1658`;

      const result = parsePropertyRadarCSV(csv);

      expect(result.contacts).toHaveLength(2);
      expect(result.stats.primaryContacts).toBe(1);
      expect(result.stats.secondaryContacts).toBe(1);
    });
  });
});
```

```typescript
// tests/unit/campaign.test.ts
describe('Campaign', () => {
  describe('selectVariant', () => {
    it('selects from variants based on weight', () => {
      const variants = [
        { id: 'A', message: 'A', weight: 50, stats: { sent: 0, responses: 0, optOuts: 0 } },
        { id: 'B', message: 'B', weight: 50, stats: { sent: 0, responses: 0, optOuts: 0 } },
      ];

      // Run many selections
      const counts = { A: 0, B: 0 };
      for (let i = 0; i < 1000; i++) {
        const selected = selectVariant(variants);
        counts[selected.id]++;
      }

      // Should be roughly 50/50 (within 10%)
      expect(counts.A).toBeGreaterThan(400);
      expect(counts.B).toBeGreaterThan(400);
    });

    it('respects unequal weights', () => {
      const variants = [
        { id: 'A', message: 'A', weight: 90, stats: { sent: 0, responses: 0, optOuts: 0 } },
        { id: 'B', message: 'B', weight: 10, stats: { sent: 0, responses: 0, optOuts: 0 } },
      ];

      const counts = { A: 0, B: 0 };
      for (let i = 0; i < 1000; i++) {
        const selected = selectVariant(variants);
        counts[selected.id]++;
      }

      expect(counts.A).toBeGreaterThan(800);
      expect(counts.B).toBeLessThan(200);
    });
  });

  describe('isOptOutMessage', () => {
    it('detects STOP keyword', () => {
      expect(isOptOutMessage('STOP')).toBe(true);
      expect(isOptOutMessage('stop')).toBe(true);
      expect(isOptOutMessage('Stop')).toBe(true);
    });

    it('detects other opt-out keywords', () => {
      expect(isOptOutMessage('CANCEL')).toBe(true);
      expect(isOptOutMessage('UNSUBSCRIBE')).toBe(true);
      expect(isOptOutMessage('QUIT')).toBe(true);
      expect(isOptOutMessage('END')).toBe(true);
    });

    it('requires whole word match', () => {
      expect(isOptOutMessage('I stopped by')).toBe(false);
      expect(isOptOutMessage('unending')).toBe(false);
    });

    it('returns false for regular messages', () => {
      expect(isOptOutMessage('Yes, interested!')).toBe(false);
      expect(isOptOutMessage('Call me tomorrow')).toBe(false);
    });
  });
});
```

### Integration Tests

```typescript
// tests/integration/campaign-send.test.ts
describe('Campaign Send Endpoint', () => {
  beforeEach(() => {
    mockQuo.reset();
    mockRedis.reset();
  });

  it('sends message via Quo and updates stats', async () => {
    mockRedis.isOptedOut.mockResolvedValue(false);
    mockQuo.sendMessage.mockResolvedValue({ id: 'msg123' });

    const response = await handleCampaignSend({
      campaignId: 'campaign-test',
      pipedrivePersonId: 123,
      phone: '+16175551234',
      message: 'Test message',
    });

    expect(response.status).toBe(200);
    expect(mockQuo.sendMessage).toHaveBeenCalledWith(
      expect.any(String), // from number
      '+16175551234',
      'Test message'
    );
    expect(mockRedis.incrementCampaignStats).toHaveBeenCalledWith('campaign-test', { sent: 1 });
  });

  it('skips opted-out phones', async () => {
    mockRedis.isOptedOut.mockResolvedValue(true);

    const response = await handleCampaignSend({
      campaignId: 'campaign-test',
      pipedrivePersonId: 123,
      phone: '+16175551234',
      message: 'Test message',
    });

    expect(response.body.skipped).toBe(true);
    expect(mockQuo.sendMessage).not.toHaveBeenCalled();
  });

  it('tracks variant stats when variant provided', async () => {
    mockRedis.isOptedOut.mockResolvedValue(false);
    mockQuo.sendMessage.mockResolvedValue({ id: 'msg123' });

    await handleCampaignSend({
      campaignId: 'campaign-test',
      pipedrivePersonId: 123,
      phone: '+16175551234',
      message: 'Test message',
      variant: 'A',
    });

    expect(mockRedis.incrementVariantStats).toHaveBeenCalledWith('campaign-test', 'A', { sent: 1 });
  });
});
```

```typescript
// tests/integration/campaign-response.test.ts
describe('Campaign Response Tracking (Quo Webhook)', () => {
  it('increments response count for campaign contact', async () => {
    mockRedis.findCampaignForPhone.mockResolvedValue({
      campaign: { id: 'campaign-test', ... },
      variant: 'A',
    });
    mockRedis.isOptOutMessage.mockReturnValue(false);

    await handleQuoWebhook(inboundMessagePayload);

    expect(mockRedis.incrementCampaignStats).toHaveBeenCalledWith('campaign-test', { responses: 1 });
    expect(mockRedis.incrementVariantStats).toHaveBeenCalledWith('campaign-test', 'A', { responses: 1 });
  });

  it('handles opt-out message from campaign contact', async () => {
    mockRedis.findCampaignForPhone.mockResolvedValue({
      campaign: { id: 'campaign-test', ... },
      variant: 'B',
    });
    mockRedis.isOptOutMessage.mockReturnValue(true);

    await handleQuoWebhook({ ...inboundMessagePayload, data: { body: 'STOP' } });

    expect(mockRedis.addOptOut).toHaveBeenCalledWith('+16175551234');
    expect(mockRedis.incrementCampaignStats).toHaveBeenCalledWith('campaign-test', { optOuts: 1 });
  });

  it('ignores messages from non-campaign contacts', async () => {
    mockRedis.findCampaignForPhone.mockResolvedValue(null);

    await handleQuoWebhook(inboundMessagePayload);

    expect(mockRedis.incrementCampaignStats).not.toHaveBeenCalled();
  });
});
```
