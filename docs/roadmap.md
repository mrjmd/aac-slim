# AAC Middleware Roadmap

**Last Updated:** December 31, 2024

This document captures the current state of the AAC Middleware project and outlines potential next steps for development.

---

## Current State

### Completed Modules

| Module | Status | Description |
|--------|--------|-------------|
| **Module 1.1** | Complete | Pipedrive <> Quo Sync Engine |
| **Module 1.2** | Complete | Google Ads Lead Capture |
| **Module 1.3** | Complete | AI Entity Extraction |
| **Module 1.4** | Complete | QuickBooks Integration |
| **Module 2** | Complete | Attribution Engine |
| **Module 3 Phase 1** | Complete | Campaign Manager MVP |
| **Module 3 Phase 2** | Complete | A/B Testing & Response Tracking |

### Module 3 (Campaign Manager) Capabilities

- CLI-based campaign execution
- Property Radar CSV import with normalization
- Quo-based deduplication (checks conversation history)
- Pipedrive contact creation before texting
- QStash-based message queuing with throttling
- A/B testing with 50/50 variant split
- Response tracking in Quo webhook
- Opt-out keyword detection
- Stats endpoint with variant analysis

---

## Potential Next Steps

### Campaign Manager Improvements

#### Phase 3: Scheduling & Time Windows
- Schedule campaign start time (e.g., "start tomorrow at 9 AM")
- Sending windows (9 AM - 5 PM ET only)
- Auto-pause outside hours, resume next day
- Track send time vs response correlation
- **Effort:** Medium

#### Additional Improvements
- Pause/resume campaign commands
- Campaign completion detection (auto-mark complete)
- CSV export of campaign results
- Message preview/validation before sending
- **Effort:** Low-Medium

### Infrastructure

#### Fix QStash Signature Verification
Currently disabled due to Vercel's body parsing breaking signature verification. Need to use raw body access.
- **Effort:** Low
- **Priority:** Should fix before production scale

#### Sync Health Dashboard
Real-time visibility into webhook processing, error rates, and sync status.
- **Effort:** Medium-High
- **Priority:** Important for operations

### Module Improvements

#### Module 1 (Sync Engine)
- Better error handling/retry logic
- Sync status monitoring
- **Effort:** Medium

#### Module 2 (Attribution Engine)
- Commission report export (CSV/PDF)
- Slack/email notifications for new attributions
- **Effort:** Low-Medium

### Testing

#### Automated Tests
- Unit tests for CSV parser, variant selection, phone normalization
- Integration test scripts
- **Effort:** Medium

#### Documentation
- Update spec docs with implementation details
- Usage guides for CLI tools
- **Effort:** Low

---

## Future Vision: UI & Marketing Platform

### Health Dashboard
A central dashboard to monitor all middleware operations:
- Webhook processing status
- Error rates and alerts
- Sync health between systems
- Queue status (QStash)
- Campaign performance at-a-glance

### Marketing Platform
The Campaign Manager is the first piece of a larger marketing automation vision:

**Phase 1 (Current):** SMS Campaign Manager
- Manual CSV import
- A/B testing
- Response tracking

**Phase 2:** Enhanced Campaign Management
- Web UI for campaign creation
- Visual A/B test builder
- Real-time stats dashboard
- Campaign templates

**Phase 3:** Multi-Channel Marketing
- Email campaigns (integrate with email provider)
- Direct mail coordination
- Retargeting integration
- Lead scoring

**Phase 4:** Automation & Intelligence
- Automated follow-up sequences
- AI-powered message optimization
- Predictive response modeling
- Geographic targeting optimization

---

## Priority Recommendations

### Immediate (Next Sprint)
1. Update documentation with implementation details
2. Create manual testing plan for Module 3
3. Fix QStash signature verification

### Short-Term (1-2 Sprints)
1. Plan UI architecture for health dashboard + marketing platform
2. Implement basic health monitoring
3. Add campaign scheduling (Phase 3)

### Medium-Term
1. Build marketing platform UI
2. Add email campaign support
3. Implement automated follow-up sequences

---

## Technical Decisions Needed

Before starting UI development:

1. **Framework:** Next.js (consistent with existing API) vs separate React app
2. **Hosting:** Vercel (unified) vs separate deployment
3. **Auth:** Simple password protection vs OAuth
4. **State:** Redis-only vs add database for UI state
5. **Design:** Custom vs component library (shadcn/ui, etc.)

These should be resolved in the planning phase before implementation.
