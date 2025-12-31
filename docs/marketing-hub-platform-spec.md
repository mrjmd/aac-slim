# AAC Marketing Hub Platform - Implementation Plan

**Last Updated:** December 31, 2024

## Vision

Transform AAC's content marketing from 10 hours/week (admin assistant) to ~1 hour/month (owner) through an AI-powered marketing content platform that handles:

- **SMS Campaigns**: Full UI for existing campaign manager (replaces CLI)
- **Health Dashboard**: Operational visibility into all middleware systems
- **Content Planning**: Annual blog calendar + 3-month rolling social calendar
- **AI Content Generation**: Gemini for copy, Imagen for images, batch generation with selection
- **Brand Consistency**: Style guide prompts + reference images for consistent visuals
- **Multi-Channel Publishing**: Direct API posting to LinkedIn, Facebook, Instagram, Google Business
- **Image Pipeline**: Auto-resize to each platform's required aspect ratios
- **Blog Workflow**: Copy-paste helper with SMS reminders for Squarespace
- **Google Ads Generation**: AI-generated ad copy and creative (other ad platforms in 2026)
- **Sora Video Integration**: Import videos from specific Sora usernames, auto-generate social copy

---

## Target Volume

- **Blog Posts**: 1/week (52/year, planned annually)
- **Social Posts**: 3-6/week, cross-posted to all platforms
- **Platforms**: LinkedIn, Facebook, Instagram, Google Business Profile (Twitter deferred)

---

## Technical Foundation

### Existing Infrastructure (aac-slim)
- Vercel serverless functions (all API endpoints working)
- Upstash Redis for data storage
- Gemini API integration (entity extraction already implemented)
- SMS via Quo/OpenPhone
- QStash for message queuing

### New Components Needed
- Next.js frontend (pages/app router)
- Simple password authentication
- Gemini Imagen API integration
- Social media platform APIs (LinkedIn, Meta, Google Business)
- Image processing (Sharp or similar for resizing)
- Content scheduling system

---

## Implementation Phases

### Phase 0: UI Foundation (Week 1)
**Goal**: Basic Next.js app with authentication and navigation

**Deliverables**:
- Next.js 14 with App Router
- Tailwind CSS + shadcn/ui components
- Simple password auth (middleware-based)
- Navigation shell: Dashboard, Campaigns, Health, Calendar, Content, Ads, Settings
- Basic dashboard home page

**Files**:
```
app/
  layout.tsx              # Root layout with nav
  page.tsx                # Dashboard home
  login/page.tsx          # Password login
  campaigns/page.tsx      # SMS campaigns (stub)
  health/page.tsx         # Health dashboard (stub)
  calendar/page.tsx       # Content calendar (stub)
  content/page.tsx        # Content library (stub)
  ads/page.tsx            # Ad generation (stub)
  settings/page.tsx       # Brand settings (stub)
middleware.ts             # Password auth check
lib/
  auth.ts                 # Simple password validation
components/
  ui/                     # shadcn components
  nav.tsx                 # Navigation
```

---

### Phase 1: SMS Campaign UI (Weeks 2-3)
**Goal**: Full UI for existing campaign manager (replaces CLI)

**Features**:
- Campaign list view with stats from existing API
- Create campaign wizard:
  - Upload CSV (Property Radar format)
  - Message editor with variable preview ({firstName}, {city})
  - A/B variant setup (optional)
  - Dry-run preview before sending
- Real-time campaign progress tracking
- Response and opt-out monitoring
- Historical campaign analytics with charts

**Reuse**:
- All existing campaign API endpoints (`/api/campaign/send`, `/api/campaign/stats`)
- CSV parsing logic from CLI
- Dedup and opt-out logic already in backend

**New API Endpoints**:
```typescript
POST /api/campaign/create    // Create campaign from UI (CSV upload)
GET  /api/campaign/list      // List all campaigns with pagination
```

---

### Phase 2: Health Dashboard (Weeks 4-5)
**Goal**: Operational visibility into all middleware systems

**Metrics**:
- Webhook processing rates (Quo, Pipedrive, Google Ads)
- Error rates and recent errors (last 24h, 7d)
- Sync status (PD↔Quo, PD↔QB mappings)
- Campaign queue status (QStash pending)
- API rate limit usage

**Implementation**:
- Add logging/metrics to Redis (counters, error logs)
- New API endpoints for metrics aggregation
- Dashboard with auto-refresh
- Alert thresholds with visual indicators (green/yellow/red)

**New API Endpoints**:
```typescript
GET /api/health/webhooks     // Webhook processing stats
GET /api/health/errors       // Recent errors with details
GET /api/health/sync         // Sync coverage stats
GET /api/health/queue        // QStash queue status
```

---

### Phase 3: Content Calendar (Weeks 6-7)
**Goal**: Visual calendar for planning content across all channels

**Features**:
- Month/week/day calendar views
- Create content slots (blog, social, ad)
- Drag-and-drop rescheduling
- Color-coded by channel/status
- Annual view for blog planning

**Data Model**:
```typescript
interface ContentSlot {
  id: string;
  type: 'blog' | 'social' | 'ad';
  scheduledDate: string;        // YYYY-MM-DD
  scheduledTime?: string;       // HH:mm (optional)
  status: 'idea' | 'draft' | 'ready' | 'published';
  title?: string;
  platforms: Platform[];        // ['linkedin', 'facebook', 'instagram', 'google', 'google-ads']
  contentId?: string;           // Link to generated content
}
```

**Storage**: Redis with keys like `calendar:2025-01` for month indexes

---

### Phase 4: AI Content Generation (Weeks 8-10)
**Goal**: Gemini-powered content creation sandbox

**Features**:
- **Topic → Batch Generate**: Enter topic, get 5-10 copy variations
- **Calendar-First**: Click date, AI suggests based on season/context
- **Image Generation**: Gemini Imagen for visuals
- **Brand Prompts**: Configurable style guide embedded in all prompts
- **Selection UI**: Compare options side-by-side, select winners

**Gemini Integration**:
```typescript
// Text generation (already have Gemini client)
generateSocialCopy(topic: string, platform: Platform, brandGuide: string): Promise<string[]>
generateBlogOutline(topic: string, brandGuide: string): Promise<BlogOutline>

// Image generation (new - Imagen via Gemini API)
generateImage(prompt: string, style: BrandStyle, referenceImages?: string[]): Promise<ImageResult>
```

**Brand Settings**:
```typescript
interface BrandSettings {
  voiceTone: string;           // "Professional but approachable..."
  visualStyle: string;         // "Clean, modern, blue/white palette..."
  referenceImages: string[];   // URLs to example images
  colorPalette: string[];      // Hex colors
  prohibitedWords: string[];   // Words to avoid
  requiredHashtags: string[];  // Always include these
}
```

---

### Phase 5: Image Pipeline (Weeks 11-12)
**Goal**: Auto-generate all platform-specific image variants

**Aspect Ratios**:
| Platform | Use Case | Ratio | Size |
|----------|----------|-------|------|
| LinkedIn | Post | 1.91:1 | 1200x627 |
| LinkedIn | Square | 1:1 | 1080x1080 |
| Facebook | Post | 1.91:1 | 1200x630 |
| Facebook | Square | 1:1 | 1080x1080 |
| Instagram | Square | 1:1 | 1080x1080 |
| Instagram | Portrait | 4:5 | 1080x1350 |
| Instagram | Story | 9:16 | 1080x1920 |
| Google Business | Post | 4:3 | 1200x900 |
| Google Ads | Various | Multiple | See Google Ads specs |
| Blog | Header | 16:9 | 1920x1080 |

**Pipeline**:
1. Generate master image (high-res, 1:1 or 16:9)
2. Smart crop/resize to each required ratio
3. Store all variants with content
4. Preview all variants before publishing

**Tech**: Sharp.js for image processing (runs in Node.js/Vercel functions)

---

### Phase 6: Multi-Channel Publishing (Weeks 13-16)
**Goal**: Direct API posting to all social platforms

**Platform APIs**:

| Platform | API | Auth Type | Notes |
|----------|-----|-----------|-------|
| LinkedIn | Pages API | OAuth 2.0 | Need company page admin access |
| Facebook | Graph API | OAuth 2.0 | Business page posting |
| Instagram | Graph API | OAuth 2.0 | Via Facebook Business |
| Google Business | My Business API | OAuth 2.0 | Business profile posting |

**Implementation Order**:
1. **LinkedIn** (most straightforward API)
2. **Facebook** (similar OAuth flow)
3. **Instagram** (via Facebook, more complex)
4. **Google Business** (different OAuth, later)

**Features**:
- OAuth connect flow for each platform
- Store tokens in Redis (like QuickBooks)
- Schedule posts via QStash (already have)
- Post status tracking
- Retry failed posts

---

### Phase 7: Blog Workflow (Weeks 17-18)
**Goal**: Streamlined Squarespace blog posting (manual but optimized)

**Features**:
- Blog post editor with markdown preview
- SEO metadata editor (title, description, keywords)
- Image gallery with copy-paste ready images
- "Ready to Publish" status triggers SMS reminder
- One-click copy all content for Squarespace paste
- Checklist: Image uploaded? SEO set? Published?

**SMS Reminders**:
```typescript
// Daily check at 8am
if (blogPosts.filter(p => p.status === 'ready' && p.scheduledDate === today).length > 0) {
  sendSms(ALERT_PHONE, "Blog post ready: {title}. Publish to Squarespace today!");
}
```

---

### Phase 8: Google Ads Generation (Weeks 19-21)
**Goal**: AI-generated Google Ads with brand consistency

**Features**:
- Campaign type selection (Search, Display, Performance Max)
- AI-generated ad copy variations (headlines, descriptions)
- Image generation for Display ads using Imagen
- Asset group organization
- Export for Google Ads upload (CSV or API)

**Ad Copy Generation**:
```typescript
interface GoogleAdCopy {
  headlines: string[];           // Up to 15, max 30 chars each
  longHeadlines: string[];       // Up to 5, max 90 chars each
  descriptions: string[];        // Up to 4, max 90 chars each
  callToAction: string;
}

generateGoogleAdCopy(
  product: string,
  targetAudience: string,
  brandGuide: BrandSettings
): Promise<GoogleAdCopy[]>        // Generate 5-10 variations
```

**Display Ad Sizes** (for image generation):
| Format | Size | Notes |
|--------|------|-------|
| Square | 250x250 | Common |
| Square | 300x250 | Most popular |
| Leaderboard | 728x90 | Desktop header |
| Large Rectangle | 336x280 | Content ads |
| Mobile Banner | 320x50 | Mobile |
| Large Mobile | 320x100 | Mobile |

**Future (2026)**: Meta Ads, LinkedIn Ads, Microsoft Ads integration

---

### Phase 9: Sora Video Integration (Weeks 22-23)
**Goal**: Import Sora-generated videos and auto-generate social copy

**Features**:
- Configure watched Sora usernames/accounts
- Auto-download new videos from watched accounts
- Video preview and management UI
- AI-generated social copy for each video:
  - Multiple copy variations per platform
  - Hashtag suggestions
  - Caption length optimization per platform
- Schedule video posts to social platforms
- Video aspect ratio variants (16:9, 9:16, 1:1)

**Workflow**:
1. System polls Sora API/feed for new videos from configured usernames
2. Auto-download and store in content library
3. Generate copy variations using Gemini (describe video context)
4. User reviews, selects copy, schedules posts
5. Posts go out via existing multi-channel publishing

**Data Model**:
```typescript
interface SoraVideo {
  id: string;
  sourceUsername: string;
  originalUrl: string;
  localPath: string;            // Stored video file
  thumbnail: string;
  duration: number;
  importedAt: string;
  generatedCopy: SocialCopy[];  // AI-generated variations
  status: 'imported' | 'copy_generated' | 'scheduled' | 'published';
}

interface SoraWatchConfig {
  usernames: string[];          // Sora usernames to watch
  autoImport: boolean;          // Auto-download new videos
  autoGenerateCopy: boolean;    // Auto-run AI copy generation
}
```

**Storage**: Videos stored in Vercel Blob or similar, metadata in Redis

---

## Data Architecture

### Redis Key Structure (New)

```
# Health Metrics
health:webhooks:{date}              # Webhook counts by date
health:errors:{date}                # Error log for date
health:sync:coverage                # Sync coverage stats

# Content Calendar
calendar:slot:{slotId}              # ContentSlot object
calendar:index:2025-01              # Set of slotIds for month
calendar:blog:2025                  # Set of blog slotIds for year

# Content Library
content:{contentId}                 # Generated content with all variants
content:images:{contentId}          # Image variants for content

# Brand Settings
brand:settings                      # BrandSettings object
brand:reference-images              # List of reference image URLs

# Social Tokens
oauth:linkedin:tokens
oauth:facebook:tokens
oauth:instagram:tokens
oauth:google-business:tokens

# Publishing Queue
publish:queue:{platform}            # Scheduled posts
publish:history:{contentId}         # Publishing results

# Google Ads
ads:campaign:{campaignId}           # Ad campaign with copy/images
ads:exports:{exportId}              # Export history

# Sora Videos
sora:config                         # SoraWatchConfig
sora:video:{videoId}                # SoraVideo object
sora:videos:pending                 # Set of videos needing copy
```

---

## UI/UX Principles

1. **Calendar-Centric**: Everything flows from the content calendar
2. **Batch Operations**: Generate multiple, select best
3. **Preview Everything**: See exactly what will post before it goes
4. **Progressive Disclosure**: Simple default, advanced options tucked away
5. **Mobile-Friendly**: Check calendar and approve posts from phone

---

## Tech Stack

| Layer | Technology |
|-------|------------|
| Frontend | Next.js 14, React 18, TypeScript |
| Styling | Tailwind CSS, shadcn/ui |
| State | SWR for API data, Zustand for UI state |
| Calendar | react-big-calendar or FullCalendar |
| Image Processing | Sharp.js |
| AI | Gemini API (text + Imagen) |
| Auth | Simple password middleware |
| Backend | Existing Vercel functions |
| Database | Upstash Redis |
| Queue | Upstash QStash |
| Hosting | Vercel |

---

## Success Criteria

### Phase 0 Complete When:
- [ ] Can log in with password
- [ ] Navigation works between all sections
- [ ] Basic dashboard home page loads

### Phase 1 Complete When:
- [ ] Can create SMS campaigns from UI (replaces CLI)
- [ ] CSV upload and parsing works
- [ ] A/B variant setup in UI
- [ ] Stats and response tracking visible
- [ ] Dry-run preview works

### Phase 2 Complete When:
- [ ] Dashboard shows all system health metrics
- [ ] Webhook processing stats visible
- [ ] Errors visible with details
- [ ] Sync coverage metrics calculated

### Phase 3 Complete When:
- [ ] Can create/edit content slots on calendar
- [ ] Can view month/week/year views
- [ ] Data persists in Redis

### Phase 4 Complete When:
- [ ] Can enter topic and get 5+ copy variations
- [ ] Can generate images with Imagen
- [ ] Brand settings affect all generation
- [ ] Can save selected content to library

### Phase 5 Complete When:
- [ ] Master image auto-generates all platform variants
- [ ] Can preview all variants
- [ ] Images stored and retrievable

### Phase 6 Complete When:
- [ ] LinkedIn OAuth connect and posting works
- [ ] Facebook/Instagram posting works
- [ ] Scheduled posts go out automatically
- [ ] Failed posts retry

### Phase 7 Complete When:
- [ ] Blog posts have full editor
- [ ] SMS reminder fires on publish day
- [ ] Copy-paste workflow tested with Squarespace

### Phase 8 Complete When:
- [ ] Can generate Google Ads copy variations
- [ ] Display ad images generated at correct sizes
- [ ] Export to CSV for Google Ads upload works

### Phase 9 Complete When:
- [ ] Can configure Sora usernames to watch
- [ ] Videos auto-import from watched accounts
- [ ] AI generates social copy for each video
- [ ] Can schedule video posts to social platforms

---

## Risk Considerations

| Risk | Mitigation |
|------|------------|
| Gemini Imagen API limits | Monitor usage, implement caching |
| Social API rate limits | Throttle posting, queue with delays |
| OAuth token expiration | Auto-refresh like QuickBooks |
| Image processing timeout | Use background jobs for large batches |
| Squarespace API unavailable | Manual workflow is fine, optimize UX |
| Sora API access | May need to use web scraping if no official API |
| Video storage costs | Use Vercel Blob with TTL, archive old videos |
| Google Ads API complexity | Start with CSV export, add API later |

---

## Estimated Timeline

| Phase | Duration | Cumulative |
|-------|----------|------------|
| Phase 0: UI Foundation | 1 week | Week 1 |
| Phase 1: SMS Campaign UI | 2 weeks | Week 3 |
| Phase 2: Health Dashboard | 2 weeks | Week 5 |
| Phase 3: Content Calendar | 2 weeks | Week 7 |
| Phase 4: AI Content Generation | 3 weeks | Week 10 |
| Phase 5: Image Pipeline | 2 weeks | Week 12 |
| Phase 6: Multi-Channel Publishing | 4 weeks | Week 16 |
| Phase 7: Blog Workflow | 2 weeks | Week 18 |
| Phase 8: Google Ads Generation | 3 weeks | Week 21 |
| Phase 9: Sora Video Integration | 2 weeks | Week 23 |

**Total: ~23 weeks for full platform**

---

## Recommended Starting Point

**Start with Phases 0-2** to establish operational foundation:
1. Get Next.js app running with auth (Phase 0)
2. Build SMS Campaign UI to replace CLI (Phase 1) - immediate operational value
3. Add Health Dashboard for visibility (Phase 2) - operational necessity

This gives you immediate value (can run campaigns from UI, see system health) while setting up for the content marketing phases that follow.

After the foundation, Phase 4 (AI Content Generation) is the high-value feature that enables the 10hrs→1hr transformation.
