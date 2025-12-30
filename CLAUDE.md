# AAC Middleware

Lightweight middleware connecting business SaaS tools (Pipedrive, Quo/OpenPhone, Google Ads) without Zapier.

## Architecture Principles

**Horizontal Independence:** Each webhook handler is a standalone module. No webhook imports another webhook. You can delete any module without breaking others.

**Vertical Sharing:** Modules share infrastructure (clients, utilities) but not business logic.

```
api/webhooks/           # Independent modules (no cross-imports)
├── pipedrive.ts        # Module 1.1a: Pipedrive → Quo sync
├── quo.ts              # Module 1.1b: Quo → Pipedrive sync + 1.3 AI entity extraction
└── google-ads.ts       # Module 1.2: Google Ads → Pipedrive

src/clients/            # Reusable API clients
├── pipedrive.ts        # Pipedrive CRUD operations
├── quo.ts              # Quo/OpenPhone CRUD operations
└── gemini.ts           # Gemini AI for entity extraction (Module 1.3)

src/lib/                # Shared utilities
├── env.ts              # Environment config
├── logger.ts           # Structured logging
├── phone.ts            # E.164 phone normalization
└── redis.ts            # Caching, dedupe, ID mappings
```

## Adding New Modules

1. **Create a new webhook handler** in `api/webhooks/` - this is your module entry point
2. **Add API client functions** to existing clients in `src/clients/`, or create new client files
3. **Add env vars** to `src/lib/env.ts` and `.env.example`
4. **Update redis.ts** only for new caching/dedupe patterns, not business logic
5. **Never import one webhook from another** - extract shared logic to clients or lib instead

## Key Patterns

**Webhook handlers:**
- Validate payload and authenticate
- Deduplicate using Redis (source + event ID)
- Extract/normalize data
- Call client functions
- Return 200 even on errors (prevents infinite retries)

**Loop prevention:**
- Pipedrive → Quo: Check `wasCreatedByMiddleware()` to skip contacts we just made
- Quo → Pipedrive: Mark created contacts with `markCreatedByMiddleware()`

**Phone numbers:** Always normalize to E.164 format using `normalizePhone()` before storage or comparison.

## Environment

- **Runtime:** Vercel Serverless Functions
- **Cache:** Upstash Redis
- **Deduplication TTL:** 24 hours
- **ID Mapping TTL:** 7 days

## Golden Rules

| System | Role |
|--------|------|
| Pipedrive | Relationship source of truth |
| Quo | Communication source of truth |
| Middleware | Stateless glue (no business data storage) |
