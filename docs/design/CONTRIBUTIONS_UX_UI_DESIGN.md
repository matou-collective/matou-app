# Matou Contributions System — UX/UI Design Document

**Version:** 1.0
**Date:** March 2026
**Purpose:** Figma design specification for all contribution system screens and flows
**Source:** CONTRIBUTIONS_SYSTEM_PRODUCT_DESIGN.md

---

## Table of Contents

1. [Design System Reference](#1-design-system-reference)
2. [Navigation & Information Architecture](#2-navigation--information-architecture)
3. [Proposals Module](#3-proposals-module)
4. [Decision Plans & Governance Module](#4-decision-plans--governance-module)
5. [Projects Module](#5-projects-module)
6. [Implementation Plans & Milestones Module](#6-implementation-plans--milestones-module)
7. [Contributions Module](#7-contributions-module)
8. [Treasury Module](#8-treasury-module)
9. [Notifications & Activity](#9-notifications--activity)
10. [User Flows](#10-user-flows)
11. [Responsive Behavior](#11-responsive-behavior)
12. [Status Badge System](#12-status-badge-system)
13. [Role-Based View Variations](#13-role-based-view-variations)

---

## 1. Design System Reference

### 1.1 Color Palette

| Token | Light Mode | Dark Mode | Usage |
|-------|-----------|-----------|-------|
| Primary | `#1e5f74` | `#7eb3b8` | Buttons, links, active states |
| Secondary | `#e8f4f8` | `#1e3340` | Backgrounds, subtle fills |
| Accent | `#4a9d9c` | `#4a9d9c` | Highlights, progress indicators |
| Destructive | `#c8463a` | `#c8463a` | Delete, decline, reject actions |
| Background | `#fafbfc` | `#0f1a23` | Page background |
| Card | `#ffffff` | `#1a2b3a` | Card surfaces |
| Border | `rgba(30,95,116,0.15)` | `rgba(126,179,184,0.15)` | Dividers, card borders |
| Muted | `#5a7b8a` | `#6a8b9a` | Secondary text, labels |

### 1.2 Typography

| Element | Size | Weight | Line Height |
|---------|------|--------|-------------|
| Page title | 1.5rem | 700 | 1.3 |
| Page subtitle | 0.95rem | 400 | 1.4 |
| Section heading | 1.1rem | 600 | 1.3 |
| Card title | 1rem | 600 | 1.3 |
| Body text | 0.9rem | 400 | 1.5 |
| Caption / label | 0.8rem | 500 | 1.4 |
| Badge text | 0.75rem | 600 | 1 |

### 1.3 Spacing Scale

| Token | Value | Usage |
|-------|-------|-------|
| xs | 4px | Inline gaps, icon padding |
| sm | 8px | Badge padding, tight groups |
| md | 12px | Card inner padding, list gaps |
| lg | 16px | Section spacing |
| xl | 24px | Page padding, major sections |
| 2xl | 32px | Page top margin |

### 1.4 Component Tokens

| Component | Radius | Shadow (hover) |
|-----------|--------|----------------|
| Card | 12px (`radius-xl`) | `0 4px 12px rgba(0,0,0,0.05)` |
| Button | 12px (`radius-xl`) | none |
| Badge / Pill | 20px | none |
| Dialog | 12px | `0 8px 32px rgba(0,0,0,0.12)` |
| Input | 8px (`radius-sm`) | none |

### 1.5 Icon Library

**Lucide Vue Next** — all icons are from this library.

Key icons for the contributions system:

| Concept | Icon Name | Usage |
|---------|-----------|-------|
| Proposals | `Vote` | Nav, headers |
| Projects | `Target` | Nav, headers |
| Contributions | `GitPullRequest` | Nav, headers, cards |
| Decision Plans | `Scale` | Headers, governance |
| Implementation Plans | `ListChecks` | Headers, milestones |
| Milestones | `Flag` | Timeline markers |
| Governance | `Landmark` | Three-house actions |
| Treasury | `Vault` | Treasury actions |
| Elder Council | `Shield` | House badge |
| Community House | `Users` | House badge |
| Contributor House | `Hammer` | House badge |
| Endorsement | `ThumbsUp` | Endorsement actions |
| Review | `Eye` | Review actions |
| Sign-off | `BadgeCheck` | Sign-off indicator |
| Assign | `UserPlus` | Assignment flow |
| Evidence | `Paperclip` | File attachments |
| Status timeline | `Clock` | History/audit trail |
| Filter | `Filter` | Filter controls |
| Search | `Search` | Search inputs |
| Create | `Plus` | Create buttons |
| Edit | `Pencil` | Edit actions |
| Delete | `Trash2` | Delete actions |
| Expand/Collapse | `ChevronDown` / `ChevronRight` | Nested items |

---

## 2. Navigation & Information Architecture

### 2.1 Sidebar Navigation Updates

The existing sidebar gains two new items within a "Contributions" group. The updated nav structure:

```
┌─────────────────────────┐
│  [Matou Logo]           │
│                         │
│  ● Home          (Home) │
│  ● Chat   (MessageSquare)│
│  ● Wallet      (Wallet) │
│  ● Activity      (Bell) │
│  ─── Contributions ───  │  ← section divider label
│  ● Proposals      (Vote)│
│  ● Projects     (Target)│
│  ● Contributions (GitPR)│  ← NEW
│  ● Treasury     (Vault) │  ← NEW (future)
│                         │
│  [User Profile]         │
└─────────────────────────┘
```

**Section divider**: A subtle label "Contributions" in muted text (0.7rem, uppercase, letter-spacing 0.05em) separating general nav from contribution system items.

### 2.2 Route Structure

```
/dashboard
  /dashboard/proposals                    ← Proposals list
  /dashboard/proposals/:id                ← Proposal detail
  /dashboard/proposals/:id/endorse        ← Endorsement view
  /dashboard/proposals/:id/decision-plan  ← Decision plan view
  /dashboard/projects                     ← Projects list
  /dashboard/projects/:id                 ← Project detail
  /dashboard/projects/:id/plans/:planId   ← Implementation plan detail
  /dashboard/contributions                ← Contributions list (all)
  /dashboard/contributions/:id            ← Contribution detail
  /dashboard/treasury                     ← Treasury overview (future)
```

### 2.3 Breadcrumb Pattern

All detail pages show a breadcrumb trail below the page header:

```
Proposals  /  [Proposal Title]  /  Decision Plan
Projects   /  [Project Title]   /  Implementation Plan  /  [Milestone]
```

Style: muted text links with `/` separator, current page in primary color.

---

## 3. Proposals Module

### 3.1 Proposals List Page (`/dashboard/proposals`)

**Layout**: Full-width content area within dashboard layout.

#### Header Section
```
┌──────────────────────────────────────────────────────────────────┐
│  Proposals                                           [+ New Proposal] │
│  Community proposals for resource allocation                          │
└──────────────────────────────────────────────────────────────────┘
```

- **Title**: "Proposals" (page-title style)
- **Subtitle**: "Community proposals for resource allocation" (muted)
- **CTA**: Primary button `+ New Proposal` (top right)

#### Filter Bar
```
┌──────────────────────────────────────────────────────────────────┐
│  [All] [Draft] [Submitted] [Endorsing] [In Review] [Approved]  │
│                                                                  │
│  [Search proposals...]                    [Type ▼] [Priority ▼] │
└──────────────────────────────────────────────────────────────────┘
```

- **Row 1**: Status filter pills (pill-shaped toggles, single-select)
- **Row 2**: Search input (left) + dropdown filters for Type and Priority (right)
- Active pill: filled primary background, white text
- Inactive pill: transparent background, 1px border

#### Proposal Card

Each proposal renders as a card in a vertical list (gap: 12px):

```
┌──────────────────────────────────────────────────────────────────┐
│  [Draft]  •  Technical  •  Medium Priority                      │
│                                                                  │
│  Implement KERI Credential Verification                         │
│  Build a system for verifying KERI credentials within the       │
│  platform, enabling trustless identity verification...          │
│                                                                  │
│  👤 Proposer Name    📅 Mar 5, 2026    💬 3 endorsements       │
│                                                                  │
│  [View Details →]                                                │
└──────────────────────────────────────────────────────────────────┘
```

**Card elements**:
- **Top row**: Status badge + type tag(s) + priority tag
- **Title**: Card title style (1rem, weight 600)
- **Description**: Truncated to 2 lines with ellipsis (body text, muted)
- **Metadata row**: Proposer avatar+name, date, endorsement count
- **Action**: Ghost button "View Details →" (right-aligned)
- **Hover**: Subtle shadow elevation, cursor pointer on entire card

### 3.2 Proposal Detail Page (`/dashboard/proposals/:id`)

**Layout**: Two-column layout (content left 65%, sidebar right 35%) on desktop, stacked on mobile.

#### Left Column — Content

```
┌──────────────────────────────────────────────────────┐
│  ← Back to Proposals                                 │
│                                                      │
│  [Endorsing]  •  Technical  •  High Priority         │
│                                                      │
│  Build Community Data Dashboard                      │
│  ─────────────────────────────────────               │
│                                                      │
│  PROBLEM STATEMENT                                   │
│  Community members lack visibility into how           │
│  contributions and governance decisions are           │
│  impacting the collective...                         │
│                                                      │
│  PROPOSED SOLUTION                                   │
│  Build an interactive dashboard showing real-time     │
│  metrics on contributions, treasury, governance...   │
│                                                      │
│  EXPECTED OUTCOMES                                   │
│  • Increased transparency in DAO operations          │
│  • Better-informed governance decisions              │
│  • Higher community engagement                       │
│                                                      │
│  BUDGET & TIMELINE                                   │
│  Estimated budget: $15,000 NZD                       │
│  Timeline: 8 weeks                                   │
│                                                      │
│  PROJECT PLAN (if provided)                          │
│  [Expandable section with milestones]                │
│                                                      │
│  ── Endorsements (5/10 required) ──────────          │
│  ┌────────────────────────────────────────┐          │
│  │ [👤 Member A] "Strong support for..."  │          │
│  │  Mar 6, 2026                           │          │
│  ├────────────────────────────────────────┤          │
│  │ [👤 Member B] "This aligns with..."    │          │
│  │  Mar 7, 2026                           │          │
│  └────────────────────────────────────────┘          │
│                                                      │
│  [+ Endorse This Proposal]                           │
│                                                      │
│  ── Status History ────────────────────              │
│  [Timeline visualization — see §3.4]                 │
└──────────────────────────────────────────────────────┘
```

**Sections**:
1. **Back link**: `← Back to Proposals` (ghost button)
2. **Status bar**: Badge + type tags + priority
3. **Title**: Large heading (1.5rem)
4. **Description**: Full text
5. **Problem Statement**: Section with heading
6. **Proposed Solution**: Section with heading
7. **Expected Outcomes**: Bulleted list
8. **Budget & Timeline**: Labeled fields
9. **Project Plan**: Expandable accordion (if provided)
10. **Endorsements section**: Progress bar + endorsement list (see §3.3)
11. **Status History**: Timeline (see §3.4)

#### Right Column — Sidebar

```
┌──────────────────────────┐
│  PROPOSAL DETAILS        │
│                          │
│  Status                  │
│  [Endorsing]             │
│                          │
│  Proposer                │
│  👤 John Doe             │
│                          │
│  Created                 │
│  Mar 5, 2026             │
│                          │
│  Last Updated            │
│  Mar 8, 2026             │
│                          │
│  Type                    │
│  [Technical] [Community] │
│                          │
│  Priority                │
│  [High]                  │
│                          │
│  ─────────────────────   │
│                          │
│  ACTIONS                 │
│  [Edit Proposal]         │ ← only for proposer, draft status
│  [Submit for Review]     │ ← proposer action
│  [Assign Lead]           │ ← admin action (in_review)
│  [Create Decision Plan]  │ ← proposal lead action
│  [Transition Status ▼]   │ ← role-dependent
│                          │
│  ─────────────────────   │
│                          │
│  LINKED PROJECT          │
│  [Project Name →]        │ ← link to project (if exists)
│                          │
│  DECISION PLAN           │
│  [View Decision Plan →]  │ ← link (if exists)
└──────────────────────────┘
```

**Sidebar elements**:
- Card surface with border
- Metadata section: status, proposer, dates, type, priority
- Actions section: Context-sensitive buttons based on user role and proposal status
- Links section: Linked project and decision plan (if they exist)

### 3.3 Endorsement Component

Appears within the proposal detail page when status is `submitted` or `endorsing`.

```
┌──────────────────────────────────────────────────────┐
│  Endorsements                                        │
│  ████████░░░░░░░░░░░░  5 of 10 required             │
│                                                      │
│  ┌────────────────────────────────────────────────┐  │
│  │ 👤 Member Name                     Mar 6, 2026 │  │
│  │ "I endorse this proposal because..."           │  │
│  └────────────────────────────────────────────────┘  │
│  ┌────────────────────────────────────────────────┐  │
│  │ 👤 Another Member                  Mar 7, 2026 │  │
│  │ (no comment)                                   │  │
│  └────────────────────────────────────────────────┘  │
│                                                      │
│  ┌────────────────────────────────────────────────┐  │
│  │ Add your endorsement                           │  │
│  │ [Comment (optional).....................]       │  │
│  │                          [Endorse Proposal]    │  │
│  └────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────┘
```

- **Progress bar**: Filled segment in accent color, empty in muted background
- **Endorsement cards**: Compact list items with avatar, name, date, comment
- **Endorse form**: Inline at bottom — optional comment textarea + primary button
- The endorse button is disabled if the user has already endorsed

### 3.4 Status Timeline Component

Reusable component showing lifecycle progression. Used on proposal, contribution, and project detail pages.

```
┌──────────────────────────────────────────────────────┐
│  Status History                                      │
│                                                      │
│  ●── Draft                              Mar 5, 2026  │
│  │   Created by John Doe                             │
│  │                                                   │
│  ●── Submitted                          Mar 6, 2026  │
│  │   Submitted for endorsement                       │
│  │                                                   │
│  ●── Endorsing                          Mar 6, 2026  │
│  │   5 endorsements collected                        │
│  │                                                   │
│  ○── In Review                          (pending)    │
│  │                                                   │
│  ○── Signed Off                         (pending)    │
│  │                                                   │
│  ○── Voting Process                     (pending)    │
│  │                                                   │
│  ○── Approved / Rejected                (pending)    │
└──────────────────────────────────────────────────────┘
```

- **Completed steps**: Filled circle (●) in accent color, solid line
- **Current step**: Filled circle with pulse animation, label in primary color
- **Future steps**: Empty circle (○) in muted color, dashed line
- **Each step**: Status label + timestamp + optional description
- Vertical layout (top to bottom)

### 3.5 Create Proposal Dialog

Triggered by `+ New Proposal` button. Uses Q-Dialog.

```
┌──────────────────────────────────────────────────────┐
│  Create Proposal                              [×]    │
│  ────────────────────────────────────────────         │
│                                                      │
│  Title *                                             │
│  [_______________________________________________]   │
│                                                      │
│  Type *                                              │
│  [Technical ▼] (multi-select chips)                  │
│                                                      │
│  Priority *                                          │
│  [Medium ▼]                                          │
│                                                      │
│  Description *                                       │
│  [_______________________________________________]   │
│  [_______________________________________________]   │
│  [_______________________________________________]   │
│                                                      │
│  Problem Statement *                                 │
│  [_______________________________________________]   │
│  [_______________________________________________]   │
│                                                      │
│  Proposed Solution *                                 │
│  [_______________________________________________]   │
│  [_______________________________________________]   │
│                                                      │
│  Expected Outcomes *                                 │
│  [Outcome 1                            ] [×]         │
│  [Outcome 2                            ] [×]         │
│  [+ Add Outcome]                                     │
│                                                      │
│  Estimated Budget *                                  │
│  [_______________________________________________]   │
│                                                      │
│  Timeline *                                          │
│  [_______________________________________________]   │
│                                                      │
│  ────────────────────────────────────────────         │
│                         [Cancel]  [Create as Draft]  │
└──────────────────────────────────────────────────────┘
```

**Form fields**:
- Title: text input
- Type: multi-select dropdown with chip display (options: technical, community, governance, operations)
- Priority: single-select dropdown (options: low, medium, high, critical)
- Description: textarea (3 rows min)
- Problem Statement: textarea (2 rows min)
- Proposed Solution: textarea (2 rows min)
- Expected Outcomes: dynamic list — each item is a text input with remove (×) button, `+ Add Outcome` link below
- Estimated Budget: text input
- Timeline: text input

**Actions**:
- Cancel: ghost button, closes dialog
- Create as Draft: primary button, saves with status `draft`

**Validation**: All required (*) fields must be non-empty. Show inline error messages below invalid fields in destructive color.

**Dialog width**: 600px min, max 700px.

---

## 4. Decision Plans & Governance Module

### 4.1 Decision Plan View (within Proposal Detail)

Accessed via tab or link from the proposal detail page. Shows the governance pathway for an approved proposal.

```
┌──────────────────────────────────────────────────────┐
│  ← Back to Proposal                                 │
│                                                      │
│  Decision Plan                            [Drafted]  │
│  ─────────────────────────────────────               │
│  Governance pathway for: "Build Community Dashboard" │
│                                                      │
│  OBJECTIVES                                          │
│  • Obtain cultural alignment from Elder Council      │
│  • Secure strategic approval from Community House    │
│  • Get technical feasibility sign-off                │
│                                                      │
│  EXPECTED OUTCOMES                                   │
│  • All three houses approve the proposal             │
│  • Budget allocated from treasury                    │
│                                                      │
│  ── Assigned Roles ─────────────────────             │
│  Proposal Lead:    👤 Jane Smith                     │
│  Proposal Steward: 👤 Bob Johnson                    │
│                                                      │
│  ── Governance Actions ─────────────────             │
│                                                      │
│  [See §4.2 Governance Actions List]                  │
│                                                      │
│  ── Actions ────────────────────────────             │
│  [Edit Plan]           ← proposal lead only, drafted │
│  [Submit for Review]   ← proposal lead, drafted      │
│  [Sign Off]            ← proposal steward, submitted │
└──────────────────────────────────────────────────────┘
```

### 4.2 Governance Actions List

Displayed within the decision plan view. Each governance action targets a specific house.

```
┌──────────────────────────────────────────────────────┐
│  Governance Actions (3)                              │
│                                                      │
│  ┌────────────────────────────────────────────────┐  │
│  │ [🛡 Elder Council]              [Planned]      │  │
│  │  Cultural Alignment Review                     │  │
│  │  Type: Discussion                              │  │
│  │  Description: Present proposal to Elder        │  │
│  │  Council for cultural alignment assessment...  │  │
│  │                                                │  │
│  │  Outcome: (pending)                            │  │
│  │                       [Record Outcome ▼]       │  │
│  └────────────────────────────────────────────────┘  │
│                                                      │
│  ┌────────────────────────────────────────────────┐  │
│  │ [👥 Community House]            [Planned]      │  │
│  │  Strategic Approval Vote                       │  │
│  │  Type: Decision                                │  │
│  │  Description: Community representatives        │  │
│  │  vote on strategic alignment and budget...     │  │
│  │                                                │  │
│  │  Outcome: (pending)                            │  │
│  │                       [Record Outcome ▼]       │  │
│  └────────────────────────────────────────────────┘  │
│                                                      │
│  ┌────────────────────────────────────────────────┐  │
│  │ [🔨 Contributor House]          [Completed]    │  │
│  │  Technical Feasibility Assessment              │  │
│  │  Type: Decision                                │  │
│  │  Description: Contributors evaluate            │  │
│  │  technical feasibility and budget...           │  │
│  │                                                │  │
│  │  Outcome: [Approved ✓]                         │  │
│  │  Votes: 12 for, 3 against (quorum met)         │  │
│  └────────────────────────────────────────────────┘  │
│                                                      │
│  [+ Add Governance Action]                           │
└──────────────────────────────────────────────────────┘
```

**House badges**: Each card has a colored house indicator:
- Elder Council: `Shield` icon, warm amber background
- Community House: `Users` icon, blue background
- Contributor House: `Hammer` icon, teal background

**Action types**: `discussion`, `decision`, `meeting` — shown as a label

**Outcome states**:
- Pending: muted text "(pending)"
- No veto: green badge "No Veto ✓"
- Veto: red badge "Vetoed ✗"
- Approved: green badge "Approved ✓"
- Rejected: red badge "Rejected ✗"

**Record Outcome dropdown** (role-dependent): Opens a small form to select outcome and optionally add vote data.

### 4.3 Record Outcome Dialog

```
┌──────────────────────────────────────────────┐
│  Record Outcome                        [×]   │
│  ──────────────────────────────────────       │
│  Action: Cultural Alignment Review           │
│  House: Elder Council                        │
│                                              │
│  Outcome *                                   │
│  ○ No Veto                                   │
│  ○ Veto                                      │
│                                              │
│  Vote Data (optional)                        │
│  For:     [___]                               │
│  Against: [___]                               │
│  Quorum:  [Met / Not Met ▼]                  │
│                                              │
│  Notes                                       │
│  [_______________________________________]   │
│                                              │
│  ──────────────────────────────────────       │
│                   [Cancel]  [Record Outcome] │
└──────────────────────────────────────────────┘
```

- For Elder Council: outcome options are `No Veto` / `Veto`
- For Community/Contributor House: outcome options are `Approved` / `Rejected`
- Vote data fields appear only for Community/Contributor houses

### 4.4 Create Decision Plan Dialog

```
┌──────────────────────────────────────────────┐
│  Create Decision Plan                  [×]   │
│  ──────────────────────────────────────       │
│  Proposal: [Pre-filled, read-only]           │
│                                              │
│  Title *                                     │
│  [_______________________________________]   │
│                                              │
│  Description *                               │
│  [_______________________________________]   │
│  [_______________________________________]   │
│                                              │
│  Objectives *                                │
│  [Objective 1                        ] [×]   │
│  [+ Add Objective]                           │
│                                              │
│  Expected Outcomes *                         │
│  [Outcome 1                          ] [×]   │
│  [+ Add Outcome]                             │
│                                              │
│  Proposal Lead *                             │
│  [Select member ▼]                           │
│                                              │
│  Proposal Steward *                          │
│  [Select member ▼]                           │
│                                              │
│  ── Governance Actions ──────────────        │
│  [+ Add Elder Council Action]                │
│  [+ Add Community House Action]              │
│  [+ Add Contributor House Action]            │
│                                              │
│  ──────────────────────────────────────       │
│                [Cancel]  [Create Plan]       │
└──────────────────────────────────────────────┘
```

**Dialog width**: 650px. Each "Add Action" button expands an inline form for that house's action (type dropdown, description textarea).

---

## 5. Projects Module

### 5.1 Projects List Page (`/dashboard/projects`)

#### Header Section
```
┌──────────────────────────────────────────────────────────────────┐
│  Projects                                          [+ New Project] │
│  Active projects and their implementation plans                    │
└──────────────────────────────────────────────────────────────────┘
```

#### Filter Bar
```
┌──────────────────────────────────────────────────────────────────┐
│  [All] [Created] [Active] [Completed] [Archived]                │
│                                                                  │
│  [Search projects...]                                            │
└──────────────────────────────────────────────────────────────────┘
```

#### Project Card

```
┌──────────────────────────────────────────────────────────────────┐
│  [Project Logo]  Community Data Dashboard           [Active]     │
│                                                                  │
│  Build an interactive dashboard showing real-time metrics on     │
│  contributions, treasury, and governance decisions...            │
│                                                                  │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐        │
│  │ Plans: 2 │  │ Miles: 5 │  │ Contribs │  │ Budget   │        │
│  │          │  │          │  │  12/18   │  │  $8.5k   │        │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘        │
│                                                                  │
│  Lead: 👤 Jane Smith    Steward: 👤 Bob Johnson                 │
│                                                                  │
│  Linked Proposals: [Community Dashboard →]                       │
│                                                                  │
│  [View Project →]                                                │
└──────────────────────────────────────────────────────────────────┘
```

**Card elements**:
- **Project image** (if available): 48x48px rounded square, left of title
- **Title + status badge**: Card title with status pill
- **Description**: Truncated to 2 lines
- **Stats row**: 4 mini stat boxes showing key metrics (implementation plans count, milestones count, contribution progress, budget)
- **People row**: Project lead and steward with avatars
- **Linked proposals**: Clickable links to associated proposals
- **Action**: Ghost button "View Project →"

### 5.2 Project Detail Page (`/dashboard/projects/:id`)

**Layout**: Full-width with tabbed content area.

#### Header
```
┌──────────────────────────────────────────────────────────────────┐
│  ← Back to Projects                                             │
│                                                                  │
│  [Project Banner Image — full width, 200px height, if exists]   │
│                                                                  │
│  [Logo] Community Data Dashboard                      [Active]   │
│                                                                  │
│  Build an interactive dashboard showing real-time metrics on     │
│  contributions, treasury, and governance decisions.              │
│                                                                  │
│  Lead: 👤 Jane Smith    Steward: 👤 Bob Johnson                 │
│  Created: Mar 10, 2026                                           │
│                                                                  │
│  Linked Proposals: [Proposal A →] [Proposal B →]                │
│                                                                  │
│  [Edit Project]  [Manage Images]          ← admin actions only  │
└──────────────────────────────────────────────────────────────────┘
```

#### Tab Bar
```
┌──────────────────────────────────────────────────────────────────┐
│  [Overview]  [Implementation Plans]  [Contributions]  [Activity] │
└──────────────────────────────────────────────────────────────────┘
```

Tabs use the standard Quasar `q-tabs` component with underline indicator.

#### Overview Tab

Shows project summary with stat cards:

```
┌──────────────────────────────────────────────────────────────────┐
│  PROJECT OVERVIEW                                                │
│                                                                  │
│  ┌────────────┐ ┌────────────┐ ┌────────────┐ ┌────────────┐   │
│  │ Total      │ │ Active     │ │ Completed  │ │ Budget     │   │
│  │ Contribs   │ │ Contribs   │ │ Contribs   │ │ Allocated  │   │
│  │    18      │ │     6      │ │    10      │ │   $15k     │   │
│  └────────────┘ └────────────┘ └────────────┘ └────────────┘   │
│                                                                  │
│  PROGRESS                                                        │
│  ████████████████░░░░░░  67% complete                            │
│                                                                  │
│  RECENT ACTIVITY                                                 │
│  • Contribution "API Design" signed off — 2h ago                 │
│  • New milestone "Phase 2" started — 1d ago                      │
│  • Contributor assigned to "Frontend" — 2d ago                   │
└──────────────────────────────────────────────────────────────────┘
```

#### Implementation Plans Tab

Shows list of implementation plans with milestone summaries. See §6.

#### Contributions Tab

Shows all contributions under this project, filterable by status. See §7.

#### Activity Tab

Shows a feed of all status changes, assignments, reviews related to this project. Uses the same FeedCard pattern as the Activity page.

### 5.3 Create Project Dialog

```
┌──────────────────────────────────────────────┐
│  Create Project                        [×]   │
│  ──────────────────────────────────────       │
│                                              │
│  Title *                                     │
│  [_______________________________________]   │
│                                              │
│  Description *                               │
│  [_______________________________________]   │
│  [_______________________________________]   │
│                                              │
│  Link to Proposals (optional)                │
│  [Search and select proposals ▼]             │
│  [Proposal A ×] [Proposal B ×]               │
│                                              │
│  Project Lead (optional)                     │
│  [Select member ▼]                           │
│                                              │
│  Project Steward (optional)                  │
│  [Select member ▼]                           │
│                                              │
│  Project Images (optional)                   │
│  [Upload Logo]  [Upload Banner]              │
│                                              │
│  ──────────────────────────────────────       │
│                [Cancel]  [Create Project]    │
└──────────────────────────────────────────────┘
```

### 5.4 Edit Project Dialog

Same as Create but pre-filled. Additional fields:
- Manage linked proposals (add/remove)
- Change lead/steward assignments
- Upload/remove images

---

## 6. Implementation Plans & Milestones Module

### 6.1 Implementation Plan Detail (`/dashboard/projects/:id/plans/:planId`)

```
┌──────────────────────────────────────────────────────────────────┐
│  ← Back to Project                                               │
│                                                                  │
│  Implementation Plan: Phase 1 — Core Platform         [Active]   │
│  Project: Community Data Dashboard                               │
│                                                                  │
│  Lead: 👤 Jane Smith    Steward: 👤 Bob Johnson                 │
│  Budget: $8,000 NZD                                              │
│                                                                  │
│  ── Milestones ────────────────────────────────────              │
│                                                                  │
│  [See §6.2 Milestone Timeline]                                   │
│                                                                  │
│  ── Actions ───────────────────────────────────────              │
│  [Edit Plan]           ← project lead, not signed off            │
│  [Add Milestone]       ← project lead                            │
│  [Submit for Sign-off] ← project lead                            │
│  [Sign Off Plan]       ← project steward                         │
└──────────────────────────────────────────────────────────────────┘
```

### 6.2 Milestone Timeline

Milestones are displayed as an expandable vertical timeline within the implementation plan detail:

```
┌──────────────────────────────────────────────────────────────────┐
│  Milestones (3)                                                  │
│                                                                  │
│  🏁 Milestone 1: API Design                     Duration: 2 wks │
│  ├── [Confirmed] Design REST endpoints               Est: 8h    │
│  ├── [Assigned]  Write OpenAPI spec                  Est: 4h    │
│  └── [Created]   Peer review API design              Est: 2h    │
│       └── [Created] Sub-task: Review auth flow       Est: 1h    │
│                                                                  │
│  🏁 Milestone 2: Backend Implementation             Duration: 3 wks │
│  ├── [Created] Implement proposal handlers           Est: 16h   │
│  ├── [Created] Implement contribution handlers       Est: 12h   │
│  └── [Created] Integration tests                     Est: 8h    │
│                                                                  │
│  🏁 Milestone 3: Frontend & Polish                   Duration: 2 wks │
│  ├── [Created] Build dashboard components            Est: 12h   │
│  └── [Created] E2E tests                             Est: 6h    │
│                                                                  │
│  [+ Add Milestone]                                               │
└──────────────────────────────────────────────────────────────────┘
```

**Elements**:
- **Milestone header**: Flag icon + title + estimated duration
- **Contribution items**: Indented under milestone, showing status badge + title + estimated hours
- **Nested contributions**: Further indented with tree connector lines
- **Expand/collapse**: Each milestone is collapsible (chevron icon)
- **Click on contribution**: Navigates to contribution detail page

### 6.3 Create Milestone Dialog

```
┌──────────────────────────────────────────────┐
│  Add Milestone                         [×]   │
│  ──────────────────────────────────────       │
│                                              │
│  Title *                                     │
│  [_______________________________________]   │
│                                              │
│  Duration *                                  │
│  [_______________________________________]   │
│                                              │
│  ──────────────────────────────────────       │
│               [Cancel]  [Add Milestone]      │
└──────────────────────────────────────────────┘
```

### 6.4 Create Implementation Plan Dialog

```
┌──────────────────────────────────────────────┐
│  Create Implementation Plan            [×]   │
│  ──────────────────────────────────────       │
│                                              │
│  Title *                                     │
│  [_______________________________________]   │
│                                              │
│  Total Budget *                              │
│  [_______________________________________]   │
│                                              │
│  Project Lead *                              │
│  [Select member ▼]                           │
│                                              │
│  Project Steward *                           │
│  [Select member ▼]                           │
│                                              │
│  ──────────────────────────────────────       │
│              [Cancel]  [Create Plan]         │
└──────────────────────────────────────────────┘
```

---

## 7. Contributions Module

### 7.1 Contributions List Page (`/dashboard/contributions`)

This is the primary landing page for all contributions across all projects.

#### Header Section
```
┌──────────────────────────────────────────────────────────────────┐
│  Contributions                                  [+ New Contribution] │
│  Track and manage all contribution work                              │
└──────────────────────────────────────────────────────────────────┘
```

#### Filter Bar
```
┌──────────────────────────────────────────────────────────────────┐
│  [All] [Created] [Confirmed] [Assigned] [Needs Review]          │
│  [Approved] [Signed Off] [Archived]                              │
│                                                                  │
│  [Search...]  [Type ▼] [Priority ▼] [Project ▼] [Assigned ▼]   │
└──────────────────────────────────────────────────────────────────┘
```

- **Row 1**: Status filter pills (wrap to 2 rows if needed)
- **Row 2**: Search + dropdowns for type, priority, project, and assigned contributor

#### View Toggle

```
[List View]  [Board View]
```

Two view options:
- **List View** (default): Vertical card list, same as proposals
- **Board View**: Kanban-style columns by status (horizontally scrollable)

#### Contribution Card (List View)

```
┌──────────────────────────────────────────────────────────────────┐
│  [Assigned]  •  Technical  •  High                    Est: 8h   │
│                                                                  │
│  Design REST API Endpoints                                       │
│  Design and document all REST API endpoints for the             │
│  contribution management system...                               │
│                                                                  │
│  Project: [Dashboard →]   Milestone: API Design                  │
│  Assigned: 👤 Jane Smith                                         │
│                                                                  │
│  Skills: [Go] [REST] [API Design]                                │
│                                                                  │
│  [View Details →]                                                │
└──────────────────────────────────────────────────────────────────┘
```

**Card elements**:
- **Top row**: Status badge + type tag + priority tag + estimated hours (right)
- **Title**: Card title
- **Description**: Truncated to 2 lines
- **Context row**: Project link + milestone name
- **Assigned**: Contributor avatar + name (or "Unassigned" in muted text)
- **Skills**: Chip/tag list of required skills
- **Action**: Ghost button "View Details →"

#### Contribution Card (Board View)

Compact card for Kanban columns:

```
┌──────────────────────┐
│  [High] Design REST  │
│  API Endpoints       │
│                      │
│  👤 Jane S.    8h    │
│  [Dashboard]         │
└──────────────────────┘
```

Board columns:
`Created` | `Confirmed` | `Assigned` | `Needs Review` | `Approved` | `Signed Off`

Cards are draggable between adjacent valid columns (enforcing FSM transitions). Invalid drops show a red indicator.

### 7.2 Contribution Detail Page (`/dashboard/contributions/:id`)

**Layout**: Two-column (content 65%, sidebar 35%).

#### Left Column — Content

```
┌──────────────────────────────────────────────────────┐
│  ← Back to Contributions                            │
│  Projects / Dashboard / API Design /                 │
│                                                      │
│  [Assigned]  •  Technical  •  High Priority          │
│                                                      │
│  Design REST API Endpoints                           │
│  ─────────────────────────────────────               │
│                                                      │
│  DESCRIPTION                                         │
│  Design and document all REST API endpoints for the  │
│  contribution management system, including request/  │
│  response schemas and error handling...              │
│                                                      │
│  OBJECTIVES                                          │
│  • Define all CRUD endpoints                         │
│  • Document request/response formats                 │
│  • Specify error codes and handling                  │
│                                                      │
│  DELIVERABLES                                        │
│  • OpenAPI specification file                        │
│  • API design document                               │
│  • Endpoint test collection                          │
│                                                      │
│  ACCEPTANCE CRITERIA                                 │
│  • All endpoints documented in OpenAPI 3.0           │
│  • All error scenarios covered                       │
│  • Peer review approved                              │
│                                                      │
│  SKILL REQUIREMENTS                                  │
│  [Go] [REST APIs] [OpenAPI] [Documentation]          │
│                                                      │
│  ── Nested Contributions (2) ──────────              │
│  [See §7.3]                                          │
│                                                      │
│  ── Evidence & Completion ─────────────              │
│  [See §7.4]                                          │
│                                                      │
│  ── Review & Sign-off ─────────────────              │
│  [See §7.5]                                          │
│                                                      │
│  ── Status History ────────────────────              │
│  [Timeline component — same as §3.4]                 │
└──────────────────────────────────────────────────────┘
```

#### Right Column — Sidebar

```
┌──────────────────────────┐
│  CONTRIBUTION DETAILS    │
│                          │
│  Status                  │
│  [Assigned]              │
│                          │
│  Project                 │
│  [Dashboard →]           │
│                          │
│  Milestone               │
│  API Design              │
│                          │
│  Assigned To             │
│  👤 Jane Smith           │
│                          │
│  Created By              │
│  👤 Bob Johnson          │
│                          │
│  Estimated Hours         │
│  8 hours                 │
│                          │
│  Actual Hours            │
│  — (not yet reported)    │
│                          │
│  Deadline                │
│  Mar 20, 2026            │
│                          │
│  Created                 │
│  Mar 10, 2026            │
│                          │
│  ─────────────────────   │
│                          │
│  ACTIONS                 │
│  [Edit Contribution]     │
│  [Submit for Review]     │
│  [Change Contribution]   │
│  [Create Sub-Contribution│
│  [Assign Contributor]    │
│  [Approve / Decline]     │
│  [Sign Off]              │
│                          │
│  ─────────────────────   │
│                          │
│  RELATIONSHIPS           │
│  Parent: [Parent Title →]│
│  Blocked By: (none)      │
│  Related: (none)         │
│  Dependencies: (none)    │
└──────────────────────────┘
```

**Actions shown depend on**:
- Current user's role
- Current contribution status
- See §13 for role-based visibility rules

### 7.3 Nested Contributions Section

Displayed within the contribution detail page when the contribution has children.

```
┌──────────────────────────────────────────────────────┐
│  Nested Contributions (2)            [+ Add Sub-task]│
│                                                      │
│  ┌────────────────────────────────────────────────┐  │
│  │ [Created] Review auth flow endpoints    Est: 1h│  │
│  │ Assigned: (unassigned)                         │  │
│  │                                  [View →]      │  │
│  └────────────────────────────────────────────────┘  │
│                                                      │
│  ┌────────────────────────────────────────────────┐  │
│  │ [Assigned] Review data model design     Est: 2h│  │
│  │ Assigned: 👤 Tom K.                            │  │
│  │                                  [View →]      │  │
│  └────────────────────────────────────────────────┘  │
│                                                      │
│  ⚠ Parent sign-off requires all nested              │
│    contributions to be signed off first.             │
└──────────────────────────────────────────────────────┘
```

- Compact card list showing status + title + hours + assignee
- Warning message about parent sign-off dependency
- `+ Add Sub-task` button (for assigned contributors and project leads)

### 7.4 Evidence & Completion Section

Appears when contribution status is `assigned` or later. The contributor fills this in when submitting for review.

```
┌──────────────────────────────────────────────────────┐
│  Evidence & Completion                               │
│                                                      │
│  ── When status is "assigned" ──                     │
│                                                      │
│  Completion Notes *                                  │
│  [_____________________________________________]     │
│  [_____________________________________________]     │
│                                                      │
│  How were acceptance criteria met? *                 │
│  [_____________________________________________]     │
│                                                      │
│  Evidence Files                                      │
│  [📎 Upload files]  or  [🔗 Add URL]                │
│  ┌─────────────────────────────────────────┐         │
│  │ 📄 api-design-v2.pdf          [Remove] │         │
│  │ 🔗 github.com/org/repo/pr/42  [Remove] │         │
│  └─────────────────────────────────────────┘         │
│                                                      │
│  Time Report                                         │
│  Actual hours spent: [___]                           │
│  [📎 Upload time report file]                        │
│                                                      │
│  [Submit for Review]                                 │
│                                                      │
│  ── When status is "needs_review" or later ──        │
│  (Read-only display of submitted evidence)           │
└──────────────────────────────────────────────────────┘
```

### 7.5 Review & Sign-off Section

Appears when status is `needs_review` or later. For project leads and stewards.

```
┌──────────────────────────────────────────────────────┐
│  Review & Sign-off                                   │
│                                                      │
│  ── Review (Project Lead) ──                         │
│                                                      │
│  Review Decision *                                   │
│  ○ Approve — Requirements met, proceed to sign-off   │
│  ○ Incomplete — Additional work required             │
│  ○ Decline — Does not meet criteria                  │
│                                                      │
│  Quality Rating *                                    │
│  [★ ★ ★ ★ ★ ★ ★ ★ ☆ ☆]  8/10                       │
│                                                      │
│  Approved Resources                                  │
│  [___] hours  [___] budget                           │
│                                                      │
│  Review Comments *                                   │
│  [_____________________________________________]     │
│                                                      │
│  [Submit Review]                                     │
│                                                      │
│  ── Sign-off (Project Steward) ──                    │
│  (Appears after approval)                            │
│                                                      │
│  [✓ Sign Off Contribution]                           │
│                                                      │
│  ── Completed Review Display ──                      │
│  Reviewed by: 👤 Jane Smith — Mar 15, 2026           │
│  Decision: [Approved ✓]                              │
│  Quality: ★★★★★★★★☆☆ (8/10)                         │
│  Comments: "Excellent API design, well documented"   │
│                                                      │
│  Signed off by: 👤 Bob Johnson — Mar 16, 2026        │
└──────────────────────────────────────────────────────┘
```

### 7.6 Contribution Assignment Flow

When a contribution is in `confirmed` status, the project lead can trigger the assignment flow.

#### Step 1: Interest Registration (Inline Component)

```
┌──────────────────────────────────────────────────────┐
│  Assignment                                          │
│                                                      │
│  This contribution is open for interest.             │
│  Registration closes: Mar 14, 2026 (48h)             │
│  ████████████████████░░░░  36h remaining             │
│                                                      │
│  Interested Contributors (3)                         │
│  ┌─────────────────────────────────────────────┐     │
│  │ 👤 Alice M.     Skills: [Go, APIs]          │     │
│  │ "I have experience with similar APIs..."    │     │
│  │                              [Select ✓]     │     │
│  ├─────────────────────────────────────────────┤     │
│  │ 👤 Tom K.       Skills: [Go, Testing]       │     │
│  │ "Available immediately, keen to help"       │     │
│  │                              [Select ✓]     │     │
│  ├─────────────────────────────────────────────┤     │
│  │ 👤 Sam R.       Skills: [Python, APIs]      │     │
│  │ "Interested in contributing to this"        │     │
│  │                              [Select ✓]     │     │
│  └─────────────────────────────────────────────┘     │
│                                                      │
│  [Register Interest]  ← for contributors             │
│  [Assign Directly]    ← for project leads            │
└──────────────────────────────────────────────────────┘
```

#### Step 2: Register Interest Dialog (for contributors)

```
┌──────────────────────────────────────────────┐
│  Register Interest                     [×]   │
│  ──────────────────────────────────────       │
│  Contribution: Design REST API Endpoints     │
│                                              │
│  Brief Statement *                           │
│  Why are you interested in this work?        │
│  [_______________________________________]   │
│  [_______________________________________]   │
│                                              │
│  Relevant Skills                             │
│  [Go ×] [REST ×] [+ Add]                    │
│                                              │
│  Availability                                │
│  ○ Available immediately                     │
│  ○ Available from [date picker]              │
│                                              │
│  ──────────────────────────────────────       │
│             [Cancel]  [Submit Interest]      │
└──────────────────────────────────────────────┘
```

#### Step 3: Assign Contributor Dialog (for project leads)

```
┌──────────────────────────────────────────────┐
│  Assign Contributor                    [×]   │
│  ──────────────────────────────────────       │
│  Contribution: Design REST API Endpoints     │
│                                              │
│  Select Contributor *                        │
│  [Search members ▼]                          │
│                                              │
│  OR select from interested:                  │
│  ○ 👤 Alice M. — "I have experience..."     │
│  ○ 👤 Tom K. — "Available immediately..."   │
│  ○ 👤 Sam R. — "Interested in..."           │
│                                              │
│  Assignment Notes (optional)                 │
│  [_______________________________________]   │
│                                              │
│  ──────────────────────────────────────       │
│        [Cancel]  [Assign Contributor]        │
└──────────────────────────────────────────────┘
```

### 7.7 Create Contribution Dialog

```
┌──────────────────────────────────────────────────────┐
│  Create Contribution                           [×]   │
│  ────────────────────────────────────────────         │
│                                                      │
│  Title *                                             │
│  [_______________________________________________]   │
│                                                      │
│  Project *                                           │
│  [Select project ▼]                                  │
│                                                      │
│  Milestone (optional)                                │
│  [Select milestone ▼]   ← filtered by project       │
│                                                      │
│  Parent Contribution (optional)                      │
│  [Select parent ▼]      ← for nested contributions  │
│                                                      │
│  Type *                                              │
│  [Technical ▼]                                       │
│                                                      │
│  Priority *                                          │
│  [Medium ▼]                                          │
│                                                      │
│  Description *                                       │
│  [_______________________________________________]   │
│  [_______________________________________________]   │
│                                                      │
│  Objectives *                                        │
│  [Objective 1                            ] [×]       │
│  [+ Add Objective]                                   │
│                                                      │
│  Deliverables *                                      │
│  [Deliverable 1                          ] [×]       │
│  [+ Add Deliverable]                                 │
│                                                      │
│  Acceptance Criteria *                               │
│  [Criterion 1                            ] [×]       │
│  [+ Add Criterion]                                   │
│                                                      │
│  Skill Requirements *                                │
│  [Go ×] [REST ×] [+ Add]                            │
│                                                      │
│  Estimated Hours *                                   │
│  [___]                                               │
│                                                      │
│  Deadline (optional)                                 │
│  [Date picker]                                       │
│                                                      │
│  Estimated Budget (optional)                         │
│  [_______________________________________________]   │
│                                                      │
│  ────────────────────────────────────────────         │
│              [Cancel]  [Create Contribution]         │
└──────────────────────────────────────────────────────┘
```

**Dialog width**: 650px. This is the largest dialog in the system due to the number of fields.

### 7.8 Change Contribution Dialog

When an assigned contributor or project lead needs to modify a contribution (triggers `changed` status → re-confirmation needed).

```
┌──────────────────────────────────────────────────────┐
│  Change Contribution                           [×]   │
│  ────────────────────────────────────────────         │
│                                                      │
│  ⚠ Changing a contribution resets it to "Confirmed"  │
│  status and requires re-confirmation before work     │
│  can resume.                                         │
│                                                      │
│  What changed? *                                     │
│  [_______________________________________________]   │
│                                                      │
│  [Pre-filled editable form fields — same as create   │
│   but with current values pre-populated]             │
│                                                      │
│  ────────────────────────────────────────────         │
│          [Cancel]  [Submit Change Request]           │
└──────────────────────────────────────────────────────┘
```

---

## 8. Treasury Module

> **Note**: Tokenomics is excluded from the current implementation scope. These screens serve as placeholder designs for future implementation.

### 8.1 Treasury Overview Page (`/dashboard/treasury`)

```
┌──────────────────────────────────────────────────────────────────┐
│  Treasury                                                        │
│  Fund allocation and reward distribution                         │
│                                                                  │
│  ┌────────────┐ ┌────────────┐ ┌────────────┐ ┌────────────┐   │
│  │ UTIL       │ │ CTR        │ │ COM        │ │ NZD        │   │
│  │ Balance    │ │ Minted     │ │ Distributed│ │ Reserved   │   │
│  │  12,500    │ │   450      │ │    120     │ │  $25,000   │   │
│  └────────────┘ └────────────┘ └────────────┘ └────────────┘   │
│                                                                  │
│  ── Pending Actions (3) ─────────────────────                    │
│  [Treasury action cards - see §8.2]                              │
│                                                                  │
│  ── Recent Distributions ─────────────────────                   │
│  [Distribution history list]                                     │
│                                                                  │
│  🔒 Coming Soon                                                  │
│  Full treasury management will be available in a future release. │
└──────────────────────────────────────────────────────────────────┘
```

### 8.2 Treasury Action Card

```
┌──────────────────────────────────────────────────────┐
│  [Pending]  Distribution — Contribution Reward       │
│                                                      │
│  Contribution: "Design REST API Endpoints"           │
│  Recipient: 👤 Jane Smith                            │
│                                                      │
│  Rewards:                                            │
│  • 50 UTIL (base) × 1.2 (tier) × 1.1 (quality) = 66│
│  • 10 CTR                                            │
│                                                      │
│  [Approve Distribution]  [Reject]                    │
└──────────────────────────────────────────────────────┘
```

---

## 9. Notifications & Activity

### 9.1 Contribution Event Types

The notification system supports 13 contribution-related SSE event types. Each generates an activity feed item and optionally a toast notification.

| Event | Feed Item Text | Toast |
|-------|---------------|-------|
| `proposal_submitted` | "Proposal '[title]' submitted for endorsement" | Yes |
| `proposal_status_changed` | "Proposal '[title]' status changed to [status]" | Yes |
| `endorsement_received` | "[name] endorsed proposal '[title]'" | No |
| `decision_plan_created` | "Decision plan created for '[proposal]'" | No |
| `governance_action_completed` | "[house] completed [action_type] for '[proposal]'" | Yes |
| `project_created` | "Project '[title]' created" | No |
| `contribution_created` | "New contribution '[title]' in [project]" | No |
| `contribution_assigned` | "[name] assigned to '[contribution]'" | Yes |
| `contribution_status_changed` | "Contribution '[title]' moved to [status]" | Yes |
| `contribution_submitted` | "[name] submitted '[contribution]' for review" | Yes |
| `contribution_reviewed` | "'[contribution]' reviewed: [outcome]" | Yes |
| `contribution_signed_off` | "'[contribution]' signed off by [name]" | Yes |
| `reward_distributed` | "Reward distributed for '[contribution]'" | Yes |

### 9.2 Toast Notifications

Toasts appear in the top-right corner of the screen. They use the existing Quasar `$q.notify` system.

```
┌────────────────────────────────────┐
│  ✓ Contribution Assigned           │
│  You've been assigned to           │
│  "Design REST API Endpoints"       │
│                     [View] [×]     │
└────────────────────────────────────┘
```

- Success: accent/teal left border
- Warning: amber left border
- Error: destructive/red left border
- "View" link navigates to the relevant detail page

### 9.3 Activity Page Integration

The existing Activity page (`/dashboard/activity`) shows contribution events in the feed alongside existing notice types. Contribution events use the `FeedCard` component with appropriate icons.

---

## 10. User Flows

### 10.1 Flow: Proposal Creation → Approval

```
Actor: Community Member (Proposer)

1. Navigate to Proposals page
2. Click "+ New Proposal"
3. Fill out Create Proposal dialog → Submit
4. Proposal created in "Draft" status
5. From proposal detail, click "Submit for Endorsement"
   → Status changes to "Submitted"
6. Share proposal with community
   → Status changes to "Endorsing"
7. Community members visit proposal detail
   → They see endorsement section
   → They click "Endorse Proposal"
   → Progress bar updates
8. Endorsement threshold met
   → Status auto-transitions to "In Review"

Actor: Admin / Operations Steward

9. Admin assigns Proposal Lead and Steward
   (from proposal detail sidebar actions)
10. Proposal Lead reviews proposal
    → Signs off → Status changes to "Signed Off"
11. Proposal Lead creates Decision Plan
    (from proposal detail → "Create Decision Plan")
12. Fills out governance actions for each house
13. Submits plan for review
14. Proposal Steward reviews and signs off plan

Actor: Governance Houses

15. Elder Council records outcome (No Veto / Veto)
16. Community House votes (Approved / Rejected)
17. Contributor House votes (Approved / Rejected)
18. All approved → Proposal status "Approved"
    → System prompts: Create new project or link existing
```

### 10.2 Flow: Project Setup → Implementation Planning

```
Actor: Admin / Operations Steward

1. Proposal approved → System shows project creation prompt
   OR: Navigate to Projects → "+ New Project"
2. Create Project dialog
   → Link to proposal(s)
   → Assign project steward and lead
3. Navigate to project detail page

Actor: Project Lead

4. In project detail → "Implementation Plans" tab
5. Click "+ Create Implementation Plan"
6. Fill out plan details (title, budget, lead, steward)
7. Within plan detail, click "+ Add Milestone"
   → Create milestones with titles and durations
8. Within each milestone, click "+ Add Contribution"
   → Create contributions (see Flow 10.3)
9. Click "Submit for Sign-off"

Actor: Project Steward

10. Review implementation plan
11. Click "Sign Off Plan"
    → Plan marked as signed off
    → Contributions within it can be marked as "Confirmed"
```

### 10.3 Flow: Contribution Lifecycle

```
Actor: Project Lead / Operations Steward

1. Create contribution (from project, milestone, or contributions page)
   → Fill out Create Contribution dialog
   → Contribution in "Created" status
2. Review contribution → Click "Confirm"
   → Status changes to "Confirmed"
3. Contribution opens for interest registration (48h window)

Actor: Contributors

4. Browse open contributions on Contributions page
   → Filter by "Confirmed" status
5. Click "Register Interest" on a contribution
   → Fill out interest form
6. Wait for assignment notification

Actor: Project Lead

7. View interested contributors on contribution detail
8. Select contributor → Click "Assign Contributor"
   → Status changes to "Assigned"
   → Contributor receives notification

Actor: Assigned Contributor

9. Work on contribution
10. (Optional) Create nested sub-contributions
    → Click "+ Add Sub-task" within contribution detail
11. Complete work
12. Fill out Evidence & Completion section:
    → Completion notes
    → How acceptance criteria were met
    → Upload evidence files or add URLs
    → Report actual hours
    → Upload time report
13. Click "Submit for Review"
    → Status changes to "Needs Review"

Actor: Project Lead

14. Review submission on contribution detail page
15. In Review section:
    → Select outcome: Approve / Incomplete / Decline
    → Set quality rating (1-10)
    → Enter review comments
    → Confirm approved resources
16. Click "Submit Review"
    → If Approved: status → "Approved"
    → If Incomplete: status → "Assigned" (contributor reworks)
    → If Declined: status → "Archived"

Actor: Project Steward / Operations Steward

17. Review approved contribution
18. Click "Sign Off Contribution"
    → Status changes to "Signed Off"
    → Treasury action generated (future: reward distribution)

System

19. (Future) Distribute rewards
    → Status changes to "Rewarded"
20. (Future) Archive
    → Status changes to "Archived"
```

### 10.4 Flow: Contribution Change

```
Actor: Assigned Contributor or Project Lead

1. On contribution detail page (status: "Assigned")
2. Click "Change Contribution"
3. Change Contribution dialog opens
   → Warning about re-confirmation requirement
   → Edit fields that need changing
   → Provide reason for change
4. Submit change
   → Status changes to "Changed"
   → Immediately transitions to "Confirmed" (requires re-confirmation)

Actor: Project Lead / Steward

5. Re-confirm the contribution
   → Status returns to "Confirmed"
6. Re-assign if needed
   → Follow normal assignment flow
```

### 10.5 Flow: Nested Contribution Creation

```
Actor: Assigned Contributor

1. On contribution detail page for their assigned contribution
2. Click "+ Add Sub-task" in Nested Contributions section
3. Create Contribution dialog opens
   → Parent contribution pre-filled (read-only)
   → Project pre-filled from parent
   → Milestone pre-filled from parent
4. Fill out sub-contribution details
5. Submit → Sub-contribution created in "Created" status

Actor: Project Lead

6. Confirm sub-contribution
7. Assign contributor (may be same as parent)
8. Sub-contribution follows normal lifecycle

Note: Parent contribution cannot be signed off until
all nested contributions are in "Signed Off" status.
```

### 10.6 Flow: Decision Plan Lifecycle

```
Actor: Proposal Lead

1. From proposal detail (status: "In Review" or "Signed Off")
2. Click "Create Decision Plan"
3. Fill out decision plan form:
   → Title, description
   → Objectives and expected outcomes
   → Assign proposal lead and steward
   → Add governance actions for each house
4. Submit → Plan in "Drafted" status

Actor: Proposal Lead

5. Click "Submit for Review"
   → Status changes to "Submitted"

Actor: Proposal Steward

6. Review decision plan
7. If changes needed → provide feedback (plan returns to "Drafted")
8. If satisfactory → Click "Sign Off"
   → Status changes to "Signed Off"
   → Proposal can proceed to voting process

Actor: Proposal Lead (during voting)

9. For each governance action:
   → Facilitate the discussion/meeting/vote in the relevant house
   → Record outcome via "Record Outcome" dialog
   → Enter vote data if applicable
10. Once all actions have outcomes recorded:
    → System evaluates results
    → Proposal transitions to "Approved" or "Rejected"
```

---

## 11. Responsive Behavior

### 11.1 Breakpoints

| Breakpoint | Width | Behavior |
|-----------|-------|----------|
| Mobile | < 640px | Single column, stacked cards, no sidebar |
| Tablet | 640–1024px | Content area full width, sidebar below content |
| Desktop | > 1024px | Two-column layout (65/35 split) |

### 11.2 Mobile Adaptations

**Navigation**: Bottom tab bar replaces sidebar on mobile (existing pattern).

**List pages**: Cards stack vertically, full width. Filter pills wrap. Search bar full width above filters.

**Detail pages**: Sidebar content moves below main content. Actions section becomes a sticky bottom action bar:

```
┌──────────────────────────────────────────┐
│  [Primary Action]    [Secondary ▼]       │  ← sticky bottom bar
└──────────────────────────────────────────┘
```

**Dialogs**: Full-screen on mobile (< 640px), dialog-style on tablet+.

**Board view**: Horizontal scroll with snap points. Each column is ~280px wide.

**Milestone timeline**: Contributions stack vertically, tree lines simplified.

### 11.3 Tablet Adaptations

**Detail pages**: Content takes full width, sidebar renders as a collapsible panel or appears below the content area.

**Filter bars**: Dropdowns collapse into a "Filters" button that opens a slide-out panel.

---

## 12. Status Badge System

### 12.1 Proposal Status Badges

| Status | Background | Text Color | Label |
|--------|-----------|------------|-------|
| `draft` | `#f0f4f8` | `#5a7b8a` | Draft |
| `submitted` | `#fff3e0` | `#e65100` | Submitted |
| `endorsing` | `#e8f5e9` | `#2e7d32` | Endorsing |
| `in_review` | `#e3f2fd` | `#1565c0` | In Review |
| `signed_off` | `#ede7f6` | `#4527a0` | Signed Off |
| `voting_process` | `#fce4ec` | `#c62828` | Voting |
| `approved` | `#e8f5e9` | `#1b5e20` | Approved |
| `rejected` | `#ffebee` | `#b71c1c` | Rejected |
| `completed` | `#e0f2f1` | `#00695c` | Completed |

### 12.2 Contribution Status Badges

| Status | Background | Text Color | Label |
|--------|-----------|------------|-------|
| `created` | `#f0f4f8` | `#5a7b8a` | Created |
| `confirmed` | `#e8f5e9` | `#2e7d32` | Confirmed |
| `assigned` | `#e3f2fd` | `#1565c0` | Assigned |
| `changed` | `#fff3e0` | `#e65100` | Changed |
| `needs_review` | `#fce4ec` | `#c62828` | Needs Review |
| `approved` | `#e8f5e9` | `#1b5e20` | Approved |
| `incomplete` | `#fff8e1` | `#f57f17` | Incomplete |
| `declined` | `#ffebee` | `#b71c1c` | Declined |
| `signed_off` | `#ede7f6` | `#4527a0` | Signed Off |
| `rewarded` | `#e0f2f1` | `#00695c` | Rewarded |
| `archived` | `#eceff1` | `#546e7a` | Archived |

### 12.3 Project Status Badges

| Status | Background | Text Color | Label |
|--------|-----------|------------|-------|
| `created` | `#f0f4f8` | `#5a7b8a` | Created |
| `active` | `#e3f2fd` | `#1565c0` | Active |
| `completed` | `#e0f2f1` | `#00695c` | Completed |
| `archived` | `#eceff1` | `#546e7a` | Archived |

### 12.4 Decision Plan Status Badges

| Status | Background | Text Color | Label |
|--------|-----------|------------|-------|
| `drafted` | `#f0f4f8` | `#5a7b8a` | Drafted |
| `submitted` | `#fff3e0` | `#e65100` | Submitted |
| `signed_off` | `#ede7f6` | `#4527a0` | Signed Off |

### 12.5 Governance Outcome Badges

| Outcome | Background | Text Color | Label |
|---------|-----------|------------|-------|
| `no_veto` | `#e8f5e9` | `#1b5e20` | No Veto ✓ |
| `veto` | `#ffebee` | `#b71c1c` | Vetoed ✗ |
| `approved` | `#e8f5e9` | `#1b5e20` | Approved ✓ |
| `rejected` | `#ffebee` | `#b71c1c` | Rejected ✗ |

### 12.6 Priority Tags

| Priority | Background | Text Color |
|----------|-----------|------------|
| `low` | `#e0f2f1` | `#00695c` |
| `medium` | `#fff3e0` | `#e65100` |
| `high` | `#fce4ec` | `#c62828` |
| `critical` | `#ffebee` | `#b71c1c` |

### 12.7 Type Tags

All type tags use the secondary background with primary text color. Displayed as small chips.

---

## 13. Role-Based View Variations

### 13.1 Action Visibility Matrix — Proposals

| Action | Status Required | Roles That See It |
|--------|----------------|-------------------|
| Edit Proposal | `draft` | Proposer |
| Submit for Endorsement | `draft` | Proposer |
| Endorse | `endorsing` | All members (except proposer) |
| Assign Lead/Steward | `in_review` | Operations Steward |
| Sign Off Proposal | `in_review` | Proposal Lead |
| Create Decision Plan | `in_review`, `signed_off` | Proposal Lead |
| Submit Decision Plan | `drafted` | Proposal Lead |
| Sign Off Decision Plan | `submitted` | Proposal Steward |
| Record Governance Outcome | `voting_process` | Proposal Lead, Operations Steward |
| Mark Completed | `approved` | Operations Steward |

### 13.2 Action Visibility Matrix — Contributions

| Action | Status Required | Roles That See It |
|--------|----------------|-------------------|
| Edit | `created` | Creator, Project Lead, Operations Steward |
| Delete | `created` | Creator, Project Lead, Operations Steward |
| Confirm | `created`, `changed` | Project Lead, Project Steward, Operations Steward |
| Register Interest | `confirmed` | All contributors |
| Assign Contributor | `confirmed` | Project Lead |
| Change Contribution | `assigned` | Assigned Contributor, Project Lead |
| Create Sub-Contribution | `assigned` | Assigned Contributor, Project Lead |
| Submit for Review | `assigned` | Assigned Contributor |
| Approve / Incomplete / Decline | `needs_review` | Project Lead |
| Sign Off | `approved` | Project Steward, Operations Steward |

### 13.3 Action Visibility Matrix — Projects

| Action | Status Required | Roles That See It |
|--------|----------------|-------------------|
| Edit Project | any | Operations Steward, Founding Member |
| Delete Project | `created` (no active plans) | Operations Steward, Founding Member |
| Create Implementation Plan | any | Project Lead, Operations Steward |
| Add Milestone | plan not signed off | Project Lead |
| Submit Plan for Sign-off | plan drafted | Project Lead |
| Sign Off Plan | plan submitted | Project Steward |
| Assign Lead/Steward | any | Operations Steward |

### 13.4 View Variations by Role

**Community Member** (no special role):
- Can view all proposals, projects, contributions (read-only for most)
- Can create proposals
- Can endorse proposals
- Can register interest in contributions
- Sees "View Details" but no admin actions

**Contributor** (assigned to a contribution):
- All community member views +
- Can create sub-contributions on their assigned contributions
- Can submit evidence and completion
- Can request changes to their assigned contributions
- Sees assignment and submission actions

**Project Lead**:
- All contributor views +
- Can create contributions within their project
- Can confirm, assign, review contributions
- Can create implementation plans and milestones
- Sees review and management actions

**Project Steward**:
- All project lead views +
- Can sign off contributions and implementation plans
- Can confirm contributions
- Sees sign-off actions

**Proposal Lead**:
- Can manage proposal through governance
- Can create and submit decision plans
- Can record governance outcomes
- Sees proposal management actions

**Operations Steward** (super admin):
- Sees all actions on all entities
- Can perform any status transition
- Can assign any role
- Full visibility

### 13.5 Empty State Variations

Each list page shows a role-appropriate empty state:

**Proposals (no proposals exist)**:
```
┌──────────────────────────────────────────┐
│         [Vote icon, 48px, 30%]           │
│                                          │
│     No proposals yet                     │
│     Be the first to propose an idea      │
│     for the community.                   │
│                                          │
│     [+ Create Proposal]                  │
└──────────────────────────────────────────┘
```

**Contributions (no contributions match filter)**:
```
┌──────────────────────────────────────────┐
│     [GitPullRequest icon, 48px, 30%]     │
│                                          │
│     No contributions found               │
│     Try adjusting your filters or        │
│     check back later.                    │
│                                          │
│     [Clear Filters]                      │
└──────────────────────────────────────────┘
```

**Projects (no projects exist)**:
```
┌──────────────────────────────────────────┐
│         [Target icon, 48px, 30%]         │
│                                          │
│     No projects yet                      │
│     Projects are created when proposals  │
│     are approved.                        │
│                                          │
│     [View Proposals →]                   │
└──────────────────────────────────────────┘
```

---

## Appendix A: Component Inventory

### Shared Components (new)

| Component | Used In | Description |
|-----------|---------|-------------|
| `StatusBadge` | All detail pages, cards | Configurable badge with status-to-color mapping |
| `PriorityTag` | Proposal & contribution cards | Priority indicator pill |
| `TypeTag` | Proposal & contribution cards | Type classification chip |
| `StatusTimeline` | Proposal, contribution detail | Vertical timeline of status changes |
| `EndorsementSection` | Proposal detail | Progress bar + endorsement list + form |
| `EvidenceSection` | Contribution detail | File upload, URL input, completion notes |
| `ReviewSection` | Contribution detail | Review form with outcome selection |
| `AssignmentSection` | Contribution detail | Interest list, assignment controls |
| `NestedContributions` | Contribution detail | Compact list of child contributions |
| `GovernanceActionCard` | Decision plan view | House-specific action card with outcome |
| `MilestoneTimeline` | Implementation plan detail | Expandable milestone tree |
| `HouseBadge` | Governance actions | Colored icon badge for each house |
| `MemberSelector` | Various dialogs | Searchable member dropdown |
| `DynamicList` | Create dialogs | Add/remove items (objectives, outcomes, etc.) |
| `ProgressBar` | Various | Configurable progress indicator |
| `Breadcrumb` | All detail pages | Navigation breadcrumb trail |

### Page Components (new)

| Component | Route | Description |
|-----------|-------|-------------|
| `ProposalDetailPage` | `/dashboard/proposals/:id` | Full proposal detail with sidebar |
| `DecisionPlanView` | Embedded in proposal detail | Decision plan and governance actions |
| `ProjectDetailPage` | `/dashboard/projects/:id` | Tabbed project detail |
| `ImplementationPlanDetail` | `/dashboard/projects/:id/plans/:planId` | Plan with milestone tree |
| `ContributionsPage` | `/dashboard/contributions` | List/board view of all contributions |
| `ContributionDetailPage` | `/dashboard/contributions/:id` | Full contribution detail with sidebar |
| `TreasuryPage` | `/dashboard/treasury` | Treasury overview (placeholder) |

### Dialog Components (new)

| Component | Trigger | Description |
|-----------|---------|-------------|
| `CreateProposalDialog` | Proposals page CTA | Full proposal creation form |
| `CreateDecisionPlanDialog` | Proposal detail action | Decision plan with governance actions |
| `RecordOutcomeDialog` | Governance action card | Outcome recording form |
| `CreateProjectDialog` | Projects page CTA | Project creation with proposal linking |
| `EditProjectDialog` | Project detail action | Edit project details |
| `CreateImplPlanDialog` | Project detail action | Implementation plan creation |
| `CreateMilestoneDialog` | Implementation plan action | Milestone creation |
| `CreateContributionDialog` | Multiple triggers | Full contribution creation form |
| `ChangeContributionDialog` | Contribution detail action | Change request with re-confirmation |
| `RegisterInterestDialog` | Contribution detail | Interest registration form |
| `AssignContributorDialog` | Contribution detail action | Contributor selection and assignment |

---

## Appendix B: Screen Count Summary

| Module | List Pages | Detail Pages | Dialogs | Sections/Components | Total Screens |
|--------|-----------|-------------|---------|---------------------|---------------|
| Proposals | 1 | 1 | 1 | 3 (endorsement, timeline, filter) | 6 |
| Decision Plans | — | 1 (embedded) | 2 | 1 (governance actions) | 4 |
| Projects | 1 | 1 | 2 | 1 (overview tab) | 5 |
| Implementation Plans | — | 1 | 2 | 1 (milestone timeline) | 4 |
| Contributions | 1 | 1 | 4 | 4 (nested, evidence, review, assignment) | 10 |
| Treasury | 1 | — | — | 1 (action card) | 2 |
| Shared | — | — | — | 6 (badge, tag, breadcrumb, etc.) | 6 |
| **Total** | **4** | **5** | **11** | **17** | **37** |

---

*This document provides the complete UX/UI specification for designing the Matou Contributions System in Figma. All screens, flows, components, and interaction patterns are derived from the authoritative product design specification (CONTRIBUTIONS_SYSTEM_PRODUCT_DESIGN.md) and align with the existing Matou design system.*
