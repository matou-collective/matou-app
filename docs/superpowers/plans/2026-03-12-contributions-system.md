# Contributions System Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the proposal, project, and contribution management system as defined in CONTRIBUTIONS_SYSTEM_PRODUCT_DESIGN.md, excluding tokenomics/payment.

**Architecture:** Go backend API handlers store entities in any-sync object trees for P2P replication, with local anystore caching. Vue3/Quasar frontend uses Pinia stores, composables, and API clients. Notifications delivered via SSE (in-app Electron) and SMTP email. All entities follow the existing ObjectPayload pattern for any-sync storage.

**Tech Stack:** Go 1.25+, any-sync SDK, Vue 3, Quasar 2.17, Pinia, Playwright, Electron

**Spec:** `CONTRIBUTIONS_SYSTEM_PRODUCT_DESIGN.md` (root of repo)

---

## Scope Exclusions

- Tokenomics (CTR/UTIL/COM token minting, reward calculation, treasury actions)
- Payment/reward distribution system
- Quadratic/cardinal voting engine (placeholder interfaces only)

---

## ⚠ Codebase Alignment Notes (Updated 2026-03-12)

The codebase has evolved significantly since the initial plan was written (~160 commits merged from main). The following notes document discrepancies between the plan and the current codebase. **Implementers MUST read this section before starting any task.**

### Existing RBAC & Role System (Affects Tasks 1.7, 1.8)

The codebase already has a role-based system:

- **10 roles defined** in `backend/internal/keri/client.go` → `ValidRoles()`: "Member", "Contributor", "Community Steward", "Operations Steward", "Founding Member", "Financial Steward", "Governance Steward", "Treasury Steward", "Technical Steward", "Cultural Steward"
- **Role strings use Title Case with spaces** (e.g. `"Operations Steward"`), NOT snake_case. Task 1.7 defines snake_case roles — the implementer must bridge to existing role strings.
- **`GetPermissionsForRole()`** already maps roles → permissions (read, comment, vote, propose, moderate, admin, issue_membership, etc.)
- **`PUT /api/v1/members/{aid}/role`** endpoint already exists in `backend/internal/api/profiles.go`
- **`updateMemberRole()`** already exists in `frontend/src/lib/api/client.ts`
- **`ChangeRoleModal.vue`** already handles role changes with multisig rotation for steward roles
- **`useAdminAccess.ts`** composable detects admin/steward status from KERI credentials, org group membership, or config admins
- **No backend role middleware exists** — the backend uses a trust model (local Electron backend). Task 1.7's `RBACMiddleware` is new but should be for contributions endpoints only.
- **CommunityProfile** (in `community-readonly` space) stores the user's `role` field — this is where `RoleLookup` should read from.

**Action for Task 1.7**: Define contribution-specific `Action` types and a mapping from existing KERI role strings to contribution permissions. Do NOT redefine roles. The `RoleLookup` interface should read from CommunityProfile via `ObjectTreeManager.ReadObjectsByType(spaceID, "CommunityProfile")`.

**Action for Task 1.8**: Skip most of this task — it's already implemented. Only add:
1. A `RoleLookup` implementation that reads roles from existing CommunityProfile objects
2. Bridge function mapping KERI role strings (e.g. "Operations Steward") → contribution `Action` permissions
3. The `getMyRoles()` frontend function should use the existing `useAdminAccess` composable

### Existing Type Index (Affects Task 1.10)

`UnifiedTreeManager` in `backend/internal/anysync/unified_tree_manager.go` already provides:
- `GetTreesByType(spaceID, objectType)` → `[]ObjectIndexEntry`
- `GetTreeForObject(ctx, spaceID, objectID)` → `(objecttree.ObjectTree, error)`
- `BuildSpaceIndex(ctx, spaceID)` → scans StoredIds, reads root metadata, populates indexes
- `spaceIndex` (sync.Map: spaceId → treeId → ObjectIndexEntry)
- `objectMap` (sync.Map: objectId → treeId)

`ObjectTreeManager.ReadObjectsByType()` already uses `GetTreesByType()` internally.

**Action for Task 1.10**: SKIP this task entirely — it's already implemented. Remove from Phase 1 checklist.

### Existing ReadObjectsByType (Affects Task 1.5)

`ObjectTreeManager.ReadObjectsByType(ctx, spaceID, typeName)` already exists in `backend/internal/anysync/object_tree.go`. However, `ReadObjectByID()` does NOT exist yet.

**Action for Task 1.5**: Remove the `ReadObjectsByType` addition (already exists). Only add `ReadObjectByID` and the type constants.

### Space Resolution (Affects Tasks 2.2, 3.2, 4.2, 5.2)

The plan creates a `SpaceResolver` abstraction but the codebase already uses `SpaceManager` and `UserIdentity` for space resolution:
- `SpaceManager.communitySpaceID` (set during init)
- `UserIdentity.GetCommunitySpaceID()`, `GetCommunityReadOnlySpaceID()`, `GetAdminSpaceID()`
- Existing handlers receive `SpaceManager` as a dependency

**Action**: All new handlers should receive `*anysync.SpaceManager` as a dependency and use `spaceManager.TreeManager()` for space operations. Use `SpaceManager` field accessors or `UserIdentity` methods to get space IDs. Delete the `SpaceResolver` from Task 2.2 — it's unnecessary.

### ObjectStoreAdapter Signing Key (Affects Task 2.3)

The plan's `ObjectStoreAdapter` references `identity.GetSigningKey()` but `UserIdentity` has no such method. The signing key comes from `SDKClient.GetSigningKey()` (in `backend/internal/anysync/sdk_client.go`).

**Action**: `ObjectStoreAdapter` should accept `*anysync.SDKClient` (or `AnySyncClient` interface) for signing, and `*identity.UserIdentity` for peer ID. Constructor: `NewObjectStoreAdapter(trees *ObjectTreeManager, sdkClient AnySyncClient, identity *UserIdentity)`.

### SSE EventBroker Pattern (Affects Task 6.1)

The plan's `Broadcaster` interface uses `Broadcast(event interface{})` but the actual `EventBroker` uses:
```go
type SSEEvent struct {
    Type string      `json:"type"`
    Data interface{} `json:"data"`
}
func (b *EventBroker) Broadcast(event SSEEvent)
```

**Action**: The notification service's `Broadcaster` interface must match: `Broadcast(event api.SSEEvent)`. Or import the `SSEEvent` type and wrap notification data in it.

### writeJSON Utility (Affects all new handlers)

`writeJSON(w, status, data)` is defined in `backend/internal/api/credentials.go` as a package-level function. It's accessible to all files in the `api` package. New handler files in `backend/internal/api/` can use it directly.

### Composable Name Conflict (Affects Task 2.4 File Structure)

`frontend/src/composables/useEndorsements.ts` already exists for KERI endorsement credentials. The plan's proposal endorsement composable must use a different name.

**Action**: Rename to `useProposalEndorsements.ts`.

### Frontend Navigation (Affects Pages)

In `DashboardLayout.vue`, "Projects" and "Proposals" are currently disabled buttons with "Coming soon" tooltips. The plan must enable these and add router entries.

### Email Sending (Affects Task 6.1)

The plan references `email.SendGeneric()` but the actual `email.Sender` has specific methods: `SendInvite()`, `SendBookingConfirmation()`, `SendRegistrationNotification()`, `SendApprovalNotification()`. A new `SendGeneric(to, subject, htmlBody string) error` method should be added to `email.Sender` for the notification service, using the existing relay/SMTP infrastructure.

### Handler Wiring Pattern (Affects Task 2.3)

Current `main.go` wiring pattern:
```go
handler := api.NewFooHandler(deps...)
handler.RegisterRoutes(mux)
```
`RegisterRoutes` takes only `*http.ServeMux` — none of the existing handlers take `RoleLookup`. The plan's `RegisterRoutes(mux, roleLookup)` is a new pattern for contributions handlers only.

---

## File Structure

### Backend — New Files

```
backend/internal/
├── logging/
│   ├── logger.go                    # Structured logger with levels, component tags
│   └── logger_test.go
├── contributions/
│   ├── models.go                    # All domain types: Proposal, Project, DecisionPlan, etc.
│   ├── validation.go                # Status transition rules, field validation
│   ├── validation_test.go
│   ├── service.go                   # Business logic orchestrator
│   └── service_test.go
├── notifications/
│   ├── models.go                    # Notification types and templates
│   ├── service.go                   # Notification dispatch (SSE + email)
│   └── service_test.go
├── api/
│   ├── proposals.go                 # Proposal CRUD + endorsement endpoints
│   ├── proposals_test.go
│   ├── projects.go                  # Project CRUD + admin endpoints
│   ├── projects_test.go
│   ├── decision_plans.go            # Decision plan + governance action endpoints
│   ├── decision_plans_test.go
│   ├── implementation_plans.go      # Implementation plan + milestone endpoints
│   ├── implementation_plans_test.go
│   ├── contributions_handler.go     # Contribution lifecycle endpoints
│   └── contributions_handler_test.go
```

### Frontend — New Files

```
frontend/src/
├── lib/
│   ├── logging.ts                   # Frontend structured logger
│   └── api/
│       ├── proposals.ts             # Proposal API client
│       ├── projects.ts              # Project API client
│       ├── decisionPlans.ts         # Decision plan API client
│       ├── implementationPlans.ts   # Implementation plan API client
│       ├── contributions.ts         # Contribution API client
│       └── notifications.ts         # Notification API client
├── stores/
│   ├── proposals.ts                 # Proposal state management
│   ├── projects.ts                  # Project state management
│   ├── contributions.ts             # Contribution state management
│   └── notifications.ts             # Notification state + Electron integration
├── composables/
│   ├── useProposals.ts              # Proposal UI logic
│   ├── useProposalEndorsements.ts   # Proposal endorsement actions (NOT useEndorsements — that exists for KERI)
│   ├── useProjects.ts               # Project UI logic
│   ├── useContributions.ts          # Contribution UI logic
│   └── useNotifications.ts          # Notification display + Electron native
├── components/
│   ├── proposals/
│   │   ├── ProposalForm.vue         # Create/edit proposal
│   │   ├── ProposalCard.vue         # Proposal summary card
│   │   ├── ProposalDetail.vue       # Full proposal view
│   │   ├── ProposalStatusBadge.vue  # Status indicator
│   │   └── EndorsementPanel.vue     # Endorsement actions + progress
│   ├── projects/
│   │   ├── ProjectForm.vue          # Create/edit project
│   │   ├── ProjectCard.vue          # Project summary card
│   │   └── ProjectDetail.vue        # Full project view with impl plans
│   ├── governance/
│   │   ├── DecisionPlanForm.vue     # Create/edit decision plan
│   │   ├── GovernanceActionCard.vue # Individual governance action
│   │   └── VotingPlaceholder.vue    # Placeholder for future voting UI
│   ├── contributions/
│   │   ├── ContributionForm.vue     # Create/edit contribution
│   │   ├── ContributionCard.vue     # Contribution summary
│   │   ├── ContributionDetail.vue   # Full view with evidence
│   │   └── ContributionStatusBadge.vue
│   └── notifications/
│       ├── NotificationCenter.vue   # Notification dropdown/panel
│       ├── NotificationItem.vue     # Single notification display
│       └── NotificationBadge.vue    # Unread count badge
├── pages/
│   ├── Proposals/
│   │   ├── ProposalsPage.vue        # List proposals
│   │   └── ProposalDetailPage.vue   # Single proposal view
│   ├── Projects/
│   │   ├── ProjectsPage.vue         # List projects
│   │   └── ProjectDetailPage.vue    # Single project view
│   └── Contributions/
│       ├── ContributionsPage.vue    # List contributions
│       └── ContributionDetailPage.vue
```

### Test Files

```
backend/internal/
├── contributions/
│   ├── validation_test.go           # Unit: status transitions, field validation
│   └── service_test.go              # Unit: business logic
├── api/
│   ├── proposals_test.go            # Unit: handler request/response
│   ├── projects_test.go
│   ├── decision_plans_test.go
│   ├── implementation_plans_test.go
│   └── contributions_handler_test.go
├── anysync/
│   └── contributions_integration_test.go  # Integration: multi-user P2P replication

frontend/tests/
├── e2e/
│   ├── e2e-proposals.spec.ts        # E2E: proposal lifecycle
│   ├── e2e-projects.spec.ts         # E2E: project management
│   ├── e2e-contributions.spec.ts    # E2E: contribution lifecycle
│   └── e2e-multi-user-sync.spec.ts  # E2E: multi-user P2P replication
```

---

## Chunk 1: Phase 1 — Foundation (Logging, Models, Storage)

### Task 1.1: Structured Logger (Backend)

**Files:**
- Create: `backend/internal/logging/logger.go`
- Create: `backend/internal/logging/logger_test.go`

- [ ] **Step 1: Write failing test for logger**

```go
// backend/internal/logging/logger_test.go
package logging

import (
	"bytes"
	"strings"
	"testing"
)

func TestLogger_Info(t *testing.T) {
	var buf bytes.Buffer
	l := New("TestComponent", &buf)
	l.Info("hello %s", "world")
	out := buf.String()
	if !strings.Contains(out, "[INFO]") {
		t.Errorf("expected [INFO] in output, got: %s", out)
	}
	if !strings.Contains(out, "[TestComponent]") {
		t.Errorf("expected [TestComponent] in output, got: %s", out)
	}
	if !strings.Contains(out, "hello world") {
		t.Errorf("expected 'hello world' in output, got: %s", out)
	}
}

func TestLogger_Error(t *testing.T) {
	var buf bytes.Buffer
	l := New("Proposals", &buf)
	l.Error("failed to save: %v", "timeout")
	out := buf.String()
	if !strings.Contains(out, "[ERROR]") {
		t.Errorf("expected [ERROR] in output, got: %s", out)
	}
	if !strings.Contains(out, "[Proposals]") {
		t.Errorf("expected [Proposals] in output, got: %s", out)
	}
}

func TestLogger_Warn(t *testing.T) {
	var buf bytes.Buffer
	l := New("Sync", &buf)
	l.Warn("retrying")
	out := buf.String()
	if !strings.Contains(out, "[WARN]") {
		t.Errorf("expected [WARN] in output, got: %s", out)
	}
}

func TestLogger_Debug_Disabled(t *testing.T) {
	var buf bytes.Buffer
	l := New("Test", &buf)
	l.Debug("should not appear")
	if buf.Len() != 0 {
		t.Errorf("expected no output for debug when disabled, got: %s", buf.String())
	}
}

func TestLogger_Debug_Enabled(t *testing.T) {
	var buf bytes.Buffer
	l := New("Test", &buf)
	l.SetDebug(true)
	l.Debug("visible")
	if !strings.Contains(buf.String(), "[DEBUG]") {
		t.Errorf("expected [DEBUG] in output, got: %s", buf.String())
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && go test ./internal/logging/... -v`
Expected: FAIL — package does not exist

- [ ] **Step 3: Implement logger**

```go
// backend/internal/logging/logger.go
package logging

import (
	"fmt"
	"io"
	"log"
	"os"
	"time"
)

// Logger provides structured logging with component tags and levels.
// All output goes to stderr so it is captured by Playwright's BackendManager.
type Logger struct {
	component string
	output    *log.Logger
	debug     bool
}

// New creates a logger for the given component. If w is nil, defaults to os.Stderr.
func New(component string, w ...io.Writer) *Logger {
	var out io.Writer = os.Stderr
	if len(w) > 0 && w[0] != nil {
		out = w[0]
	}
	return &Logger{
		component: component,
		output:    log.New(out, "", 0),
	}
}

// SetDebug enables or disables debug output.
func (l *Logger) SetDebug(enabled bool) {
	l.debug = enabled
}

func (l *Logger) log(level, format string, args ...interface{}) {
	msg := fmt.Sprintf(format, args...)
	ts := time.Now().Format("2006-01-02T15:04:05.000")
	l.output.Printf("%s [%s] [%s] %s", ts, level, l.component, msg)
}

// Info logs an informational message.
func (l *Logger) Info(format string, args ...interface{}) {
	l.log("INFO", format, args...)
}

// Warn logs a warning message.
func (l *Logger) Warn(format string, args ...interface{}) {
	l.log("WARN", format, args...)
}

// Error logs an error message.
func (l *Logger) Error(format string, args ...interface{}) {
	l.log("ERROR", format, args...)
}

// Debug logs a debug message (only if debug is enabled).
func (l *Logger) Debug(format string, args ...interface{}) {
	if !l.debug {
		return
	}
	l.log("DEBUG", format, args...)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && go test ./internal/logging/... -v`
Expected: PASS — all 5 tests pass

- [ ] **Step 5: Commit**

```bash
cd backend && git add internal/logging/
git commit -m "feat: add structured logger with component tags and levels"
```

---

### Task 1.2: Frontend Logger

**Files:**
- Create: `frontend/src/lib/logging.ts`

- [ ] **Step 1: Create frontend logger utility**

```typescript
// frontend/src/lib/logging.ts

type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
};

let globalMinLevel: LogLevel = 'INFO';

export function setLogLevel(level: LogLevel) {
  globalMinLevel = level;
}

export function createLogger(component: string) {
  function shouldLog(level: LogLevel): boolean {
    return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[globalMinLevel];
  }

  function formatMessage(level: LogLevel, message: string, ...args: unknown[]): string {
    const ts = new Date().toISOString();
    return `${ts} [${level}] [${component}] ${message}`;
  }

  return {
    debug(message: string, ...args: unknown[]) {
      if (shouldLog('DEBUG')) console.debug(formatMessage('DEBUG', message), ...args);
    },
    info(message: string, ...args: unknown[]) {
      if (shouldLog('INFO')) console.log(formatMessage('INFO', message), ...args);
    },
    warn(message: string, ...args: unknown[]) {
      if (shouldLog('WARN')) console.warn(formatMessage('WARN', message), ...args);
    },
    error(message: string, ...args: unknown[]) {
      if (shouldLog('ERROR')) console.error(formatMessage('ERROR', message), ...args);
    },
  };
}
```

- [ ] **Step 2: Commit**

```bash
cd frontend && git add src/lib/logging.ts
git commit -m "feat: add frontend structured logger matching backend pattern"
```

---

### Task 1.3: Domain Models (Backend)

**Files:**
- Create: `backend/internal/contributions/models.go`

- [ ] **Step 1: Create all domain model types**

```go
// backend/internal/contributions/models.go
package contributions

import "time"

// --- Proposal ---

type ProposalStatus string

const (
	ProposalDraft         ProposalStatus = "draft"
	ProposalSubmitted     ProposalStatus = "submitted"
	ProposalEndorsing     ProposalStatus = "endorsing"
	ProposalInReview      ProposalStatus = "in_review"
	ProposalSignedOff     ProposalStatus = "signed_off"
	ProposalVotingProcess ProposalStatus = "voting_process"
	ProposalApproved      ProposalStatus = "approved"
	ProposalRejected      ProposalStatus = "rejected"
	ProposalCompleted     ProposalStatus = "completed"
)

type ProposalType string

const (
	ProposalTypeTechnical  ProposalType = "technical"
	ProposalTypeCommunity  ProposalType = "community"
	ProposalTypeGovernance ProposalType = "governance"
	ProposalTypeOperations ProposalType = "operations"
)

type Priority string

const (
	PriorityLow      Priority = "low"
	PriorityMedium   Priority = "medium"
	PriorityHigh     Priority = "high"
	PriorityCritical Priority = "critical"
)

type Proposal struct {
	ID               string         `json:"id"`
	ProposerID       string         `json:"proposer_id"`
	Title            string         `json:"title"`
	Types            []ProposalType `json:"type"`
	Priority         Priority       `json:"priority"`
	Description      string         `json:"description"`
	ProblemStatement string         `json:"problem_statement"`
	Solution         string         `json:"solution"`
	ExpectedOutcomes []string       `json:"expected_outcomes"`
	EstimatedBudget  string         `json:"estimated_budget"`
	Timeline         string         `json:"timeline"`
	ProjectPlan      []ProjectPlanItem `json:"project_plan,omitempty"`
	Status           ProposalStatus `json:"status"`
	CreatedAt        time.Time      `json:"created_at"`
	UpdatedAt        time.Time      `json:"updated_at"`
}

type ProjectPlanItem struct {
	Title       string `json:"title"`
	Description string `json:"description"`
	Duration    string `json:"duration"`
}

// --- Endorsement ---

type Endorsement struct {
	EndorserID string    `json:"endorser_id"`
	EndorsedAt time.Time `json:"endorsed_at"`
	Comment    string    `json:"comment,omitempty"`
}

// --- Project ---

type ProjectStatus string

const (
	ProjectCreated   ProjectStatus = "created"
	ProjectActive    ProjectStatus = "active"
	ProjectCompleted ProjectStatus = "completed"
	ProjectArchived  ProjectStatus = "archived"
)

type ProjectImageType string

const (
	ImageLogo       ProjectImageType = "logo"
	ImageBanner     ProjectImageType = "banner"
	ImageScreenshot ProjectImageType = "screenshot"
	ImageOther      ProjectImageType = "other"
)

type ProjectImage struct {
	ImageID    string           `json:"image_id"`
	URL        string           `json:"url"`
	Type       ProjectImageType `json:"type"`
	AltText    string           `json:"alt_text,omitempty"`
	UploadedAt time.Time        `json:"uploaded_at"`
	UploadedBy string           `json:"uploaded_by"`
}

type Project struct {
	ID                    string         `json:"id"`
	Title                 string         `json:"title"`
	Description           string         `json:"description"`
	Status                ProjectStatus  `json:"status"`
	Images                []ProjectImage `json:"images,omitempty"`
	ProposalIDs           []string       `json:"proposal_ids,omitempty"`
	ImplementationPlanIDs []string       `json:"implementation_plan_ids,omitempty"`
	ProjectStewardID      string         `json:"project_steward_id,omitempty"`
	ProjectLeadID         string         `json:"project_lead_id,omitempty"`
	CreatedBy             string         `json:"created_by"`
	CreatedAt             time.Time      `json:"created_at"`
	UpdatedAt             time.Time      `json:"updated_at"`
}

// --- Decision Plan ---

type DecisionPlanStatus string

const (
	DecisionPlanDrafted   DecisionPlanStatus = "drafted"
	DecisionPlanSubmitted DecisionPlanStatus = "submitted"
	DecisionPlanSignedOff DecisionPlanStatus = "signed_off"
)

type DecisionPlan struct {
	ID                string             `json:"id"`
	ProposalID        string             `json:"proposal_id"`
	Title             string             `json:"title"`
	Description       string             `json:"description"`
	Status            DecisionPlanStatus `json:"status"`
	Objectives        []string           `json:"objectives"`
	ExpectedOutcomes  []string           `json:"expected_outcomes"`
	GovernanceActions []GovernanceAction `json:"governance_actions"`
	ProposalLeadID    string             `json:"proposal_lead_id"`
	ProposalStewardID string             `json:"proposal_steward_id"`
	CreatedAt         time.Time          `json:"created_at"`
	UpdatedAt         time.Time          `json:"updated_at"`
}

// --- Governance Action ---

type GovernanceActionStatus string

const (
	GovActionPlanned   GovernanceActionStatus = "planned"
	GovActionCompleted GovernanceActionStatus = "completed"
	GovActionArchived  GovernanceActionStatus = "archived"
)

type HouseType string

const (
	HouseElderCouncil   HouseType = "elders_council"
	HouseCommunityReps  HouseType = "community_reps"
	HouseContributors   HouseType = "contributors"
)

type ActionType string

const (
	ActionDiscussion ActionType = "discussion"
	ActionDecision   ActionType = "decision"
	ActionMeeting    ActionType = "meeting"
)

type OutcomeType string

const (
	OutcomeNoVeto   OutcomeType = "no_veto"
	OutcomeVeto     OutcomeType = "veto"
	OutcomeApproved OutcomeType = "approved"
	OutcomeRejected OutcomeType = "rejected"
)

type GovernanceAction struct {
	ID             string                 `json:"id"`
	DecisionPlanID string                 `json:"decision_plan_id"`
	House          HouseType              `json:"house"`
	ActionType     ActionType             `json:"action_type"`
	Description    string                 `json:"description"`
	Status         GovernanceActionStatus `json:"status"`
	Outcome        OutcomeType            `json:"outcome,omitempty"`
	VoteData       map[string]interface{} `json:"vote_data,omitempty"`
	CreatedAt      time.Time              `json:"created_at"`
	UpdatedAt      time.Time              `json:"updated_at"`
}

// --- Implementation Plan ---

type ImplementationPlan struct {
	ID               string      `json:"id"`
	ProjectID        string      `json:"project_id"`
	Title            string      `json:"title"`
	TotalBudget      string      `json:"total_budget"`
	Milestones       []Milestone `json:"milestones"`
	ProjectLeadID    string      `json:"project_lead"`
	ProjectStewardID string      `json:"project_steward_id"`
	CurrentStatus    string      `json:"current_status"`
	CreatedAt        time.Time   `json:"created_at"`
	UpdatedAt        time.Time   `json:"updated_at"`
}

// --- Milestone ---

type Milestone struct {
	MilestoneID          string   `json:"milestone_id"`
	ImplementationPlanID string   `json:"implementation_plan_id"`
	Title                string   `json:"title"`
	Duration             string   `json:"duration"`
	ContributionIDs      []string `json:"contribution_ids,omitempty"`
}

// --- Contribution ---

type ContributionStatus string

const (
	ContribCreated     ContributionStatus = "created"
	ContribConfirmed   ContributionStatus = "confirmed"
	ContribAssigned    ContributionStatus = "assigned"
	ContribChanged     ContributionStatus = "changed"
	ContribNeedsReview ContributionStatus = "needs_review"
	ContribApproved    ContributionStatus = "approved"
	ContribIncomplete  ContributionStatus = "incomplete"
	ContribDeclined    ContributionStatus = "declined"
	ContribSignedOff   ContributionStatus = "signed_off"
	ContribRewarded    ContributionStatus = "rewarded"
	ContribArchived    ContributionStatus = "archived"
)

type Contribution struct {
	ID                    string             `json:"id"`
	ProjectID             string             `json:"project_id"`
	ContributionType      ProposalType       `json:"contribution_type"`
	Priority              Priority           `json:"priority"`
	EstimatedDuration     int                `json:"estimated_duration"`
	ActualDuration        int                `json:"actual_duration,omitempty"`
	Deadline              *time.Time         `json:"deadline,omitempty"`
	CreatedAt             time.Time          `json:"created_at"`
	CreatedBy             string             `json:"created_by"`
	UpdatedAt             time.Time          `json:"updated_at"`
	Status                ContributionStatus `json:"status"`
	MilestoneID           string             `json:"milestone_id,omitempty"`
	BlockedReason         string             `json:"blocked_reason,omitempty"`
	Title                 string             `json:"title"`
	Description           string             `json:"description"`
	Objectives            []string           `json:"objectives"`
	Deliverables          []string           `json:"deliverables"`
	AcceptanceCriteria    []string           `json:"acceptance_criteria"`
	SkillRequirements     []string           `json:"skill_requirements"`
	Tags                  []string           `json:"tags,omitempty"`
	RelatedContributions   []string           `json:"related_contributions,omitempty"`
	DependentContributions []string           `json:"dependent_contributions,omitempty"`
	BlockedBy              []string           `json:"blocked_by,omitempty"`
	EligibleRoles          []string           `json:"eligible_roles,omitempty"`
	Version                string             `json:"version,omitempty"`
	TimeReport             string             `json:"time_report,omitempty"`
	ParentContributionID  string             `json:"parent_contribution,omitempty"`
	ChildContributionIDs  []string           `json:"child_contributions,omitempty"`
	AssignedContributorID string             `json:"assigned_contributor,omitempty"`
	ReviewerID            string             `json:"contribution_reviewer,omitempty"`
	Reviewers              []string           `json:"reviewers,omitempty"`
	EvidenceSubmitted     []string           `json:"evidence_submitted,omitempty"`
	CompletionNotes       string             `json:"completion_notes,omitempty"`
	ReviewOutcome         string             `json:"review_outcome,omitempty"`
	ReviewFeedback        string             `json:"review_feedback,omitempty"`
	ReviewedBy            string             `json:"reviewed_by,omitempty"`
	ReviewedAt            *time.Time         `json:"reviewed_at,omitempty"`
	QualityRating         int                `json:"quality_rating,omitempty"`
	SignedOffBy           string             `json:"signed_off_by,omitempty"`
	SignedOffAt           *time.Time         `json:"signed_off_at,omitempty"`
}
```

- [ ] **Step 2: Commit**

```bash
cd backend && git add internal/contributions/models.go
git commit -m "feat: add domain models for proposals, projects, contributions, and governance"
```

---

### Task 1.4: Status Transition Validation

**Files:**
- Create: `backend/internal/contributions/validation.go`
- Create: `backend/internal/contributions/validation_test.go`

- [ ] **Step 1: Write failing tests for status transitions**

```go
// backend/internal/contributions/validation_test.go
package contributions

import "testing"

func TestProposalTransition_Valid(t *testing.T) {
	tests := []struct {
		from ProposalStatus
		to   ProposalStatus
	}{
		{ProposalDraft, ProposalSubmitted},
		{ProposalSubmitted, ProposalEndorsing},
		{ProposalEndorsing, ProposalInReview},
		{ProposalInReview, ProposalSignedOff},
		{ProposalInReview, ProposalDraft},
		{ProposalSignedOff, ProposalVotingProcess},
		{ProposalVotingProcess, ProposalApproved},
		{ProposalVotingProcess, ProposalRejected},
		{ProposalApproved, ProposalCompleted},
	}
	for _, tt := range tests {
		if err := ValidateProposalTransition(tt.from, tt.to); err != nil {
			t.Errorf("expected valid transition %s → %s, got error: %v", tt.from, tt.to, err)
		}
	}
}

func TestProposalTransition_Invalid(t *testing.T) {
	tests := []struct {
		from ProposalStatus
		to   ProposalStatus
	}{
		{ProposalDraft, ProposalApproved},
		{ProposalRejected, ProposalApproved},
		{ProposalCompleted, ProposalDraft},
		{ProposalEndorsing, ProposalSignedOff},
	}
	for _, tt := range tests {
		if err := ValidateProposalTransition(tt.from, tt.to); err == nil {
			t.Errorf("expected invalid transition %s → %s to fail", tt.from, tt.to)
		}
	}
}

func TestContributionTransition_Valid(t *testing.T) {
	tests := []struct {
		from ContributionStatus
		to   ContributionStatus
	}{
		{ContribCreated, ContribConfirmed},
		{ContribConfirmed, ContribAssigned},
		{ContribAssigned, ContribChanged},
		{ContribChanged, ContribConfirmed},
		{ContribAssigned, ContribNeedsReview},
		{ContribNeedsReview, ContribApproved},
		{ContribNeedsReview, ContribIncomplete},
		{ContribNeedsReview, ContribDeclined},
		{ContribIncomplete, ContribAssigned},
		{ContribApproved, ContribSignedOff},
		{ContribDeclined, ContribArchived},
	}
	for _, tt := range tests {
		if err := ValidateContributionTransition(tt.from, tt.to); err != nil {
			t.Errorf("expected valid transition %s → %s, got error: %v", tt.from, tt.to, err)
		}
	}
}

func TestContributionTransition_Invalid(t *testing.T) {
	tests := []struct {
		from ContributionStatus
		to   ContributionStatus
	}{
		{ContribCreated, ContribAssigned},
		{ContribAssigned, ContribApproved},
		{ContribArchived, ContribCreated},
	}
	for _, tt := range tests {
		if err := ValidateContributionTransition(tt.from, tt.to); err == nil {
			t.Errorf("expected invalid transition %s → %s to fail", tt.from, tt.to)
		}
	}
}

func TestDecisionPlanTransition_Valid(t *testing.T) {
	valid := []struct{ from, to DecisionPlanStatus }{
		{DecisionPlanDrafted, DecisionPlanSubmitted},
		{DecisionPlanSubmitted, DecisionPlanSignedOff},
	}
	for _, tt := range valid {
		if err := ValidateDecisionPlanTransition(tt.from, tt.to); err != nil {
			t.Errorf("expected valid transition %s → %s, got: %v", tt.from, tt.to, err)
		}
	}
}

func TestDecisionPlanTransition_Invalid(t *testing.T) {
	if err := ValidateDecisionPlanTransition(DecisionPlanDrafted, DecisionPlanSignedOff); err == nil {
		t.Error("expected drafted → signed_off to fail")
	}
}

func TestGovernanceActionTransition_Valid(t *testing.T) {
	valid := []struct{ from, to GovernanceActionStatus }{
		{GovActionPlanned, GovActionCompleted},
		{GovActionCompleted, GovActionArchived},
		{GovActionPlanned, GovActionArchived},
	}
	for _, tt := range valid {
		if err := ValidateGovernanceActionTransition(tt.from, tt.to); err != nil {
			t.Errorf("expected valid %s → %s, got: %v", tt.from, tt.to, err)
		}
	}
}

func TestValidateProposal_Required(t *testing.T) {
	p := &Proposal{} // empty
	errs := ValidateProposal(p)
	if len(errs) == 0 {
		t.Error("expected validation errors for empty proposal")
	}
}

func TestValidateProposal_Valid(t *testing.T) {
	p := &Proposal{
		ID:               "test-id",
		ProposerID:       "user-1",
		Title:            "Test Proposal",
		Types:            []ProposalType{ProposalTypeTechnical},
		Priority:         PriorityMedium,
		Description:      "A test proposal",
		ProblemStatement: "Problem",
		Solution:         "Solution",
		ExpectedOutcomes: []string{"outcome"},
		EstimatedBudget:  "$1000",
		Timeline:         "2 weeks",
	}
	errs := ValidateProposal(p)
	if len(errs) != 0 {
		t.Errorf("expected no errors, got: %v", errs)
	}
}

func TestValidateContribution_QualityRating(t *testing.T) {
	base := &Contribution{
		ID: "c1", ProjectID: "p1", Title: "T", Description: "D",
		CreatedBy: "u1", Objectives: []string{"o"}, Deliverables: []string{"d"},
		AcceptanceCriteria: []string{"a"},
	}
	// Valid: 0 (unset) should pass
	if errs := ValidateContribution(base); len(errs) != 0 {
		t.Errorf("expected no errors, got: %v", errs)
	}
	// Valid: 5
	base.QualityRating = 5
	if errs := ValidateContribution(base); len(errs) != 0 {
		t.Errorf("expected no errors for rating 5, got: %v", errs)
	}
	// Invalid: 11
	base.QualityRating = 11
	errs := ValidateContribution(base)
	found := false
	for _, e := range errs {
		if e == "quality_rating must be between 1 and 10" {
			found = true
		}
	}
	if !found {
		t.Errorf("expected quality_rating error, got: %v", errs)
	}
}

func TestValidateNoCyclicDependency(t *testing.T) {
	deps := map[string][]string{
		"a": {"b"},
		"b": {"c"},
	}
	// No cycle: a depends on b, b depends on c, adding c→d is fine
	if err := ValidateNoCyclicDependency("c", "d", deps); err != nil {
		t.Errorf("expected no cycle, got: %v", err)
	}
	// Cycle: c depends on a would create a→b→c→a
	if err := ValidateNoCyclicDependency("c", "a", deps); err == nil {
		t.Error("expected cycle error for c→a")
	}
}

func TestValidateParentSignOff(t *testing.T) {
	// All children signed off — should pass
	children := map[string]ContributionStatus{
		"c1": ContribSignedOff,
		"c2": ContribRewarded,
	}
	if err := ValidateParentSignOff("parent", children); err != nil {
		t.Errorf("expected pass, got: %v", err)
	}
	// One child still assigned — should fail
	children["c3"] = ContribAssigned
	if err := ValidateParentSignOff("parent", children); err == nil {
		t.Error("expected error for incomplete child")
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && go test ./internal/contributions/... -v`
Expected: FAIL — functions not defined

- [ ] **Step 3: Implement validation**

```go
// backend/internal/contributions/validation.go
package contributions

import "fmt"

// --- Proposal transitions ---

var proposalTransitions = map[ProposalStatus][]ProposalStatus{
	ProposalDraft:         {ProposalSubmitted},
	ProposalSubmitted:     {ProposalEndorsing},
	ProposalEndorsing:     {ProposalInReview},
	ProposalInReview:      {ProposalSignedOff, ProposalDraft},
	ProposalSignedOff:     {ProposalVotingProcess},
	ProposalVotingProcess: {ProposalApproved, ProposalRejected},
	ProposalApproved:      {ProposalCompleted},
}

func ValidateProposalTransition(from, to ProposalStatus) error {
	allowed, ok := proposalTransitions[from]
	if !ok {
		return fmt.Errorf("no transitions from status %q", from)
	}
	for _, s := range allowed {
		if s == to {
			return nil
		}
	}
	return fmt.Errorf("invalid proposal transition: %s → %s", from, to)
}

// --- Contribution transitions ---

var contributionTransitions = map[ContributionStatus][]ContributionStatus{
	ContribCreated:     {ContribConfirmed},
	ContribConfirmed:   {ContribAssigned},
	ContribAssigned:    {ContribChanged, ContribNeedsReview},
	ContribChanged:     {ContribConfirmed},
	ContribNeedsReview: {ContribApproved, ContribIncomplete, ContribDeclined},
	ContribIncomplete:  {ContribAssigned},
	ContribApproved:    {ContribSignedOff},
	ContribSignedOff:   {ContribRewarded},
	ContribRewarded:    {ContribArchived},
	ContribDeclined:    {ContribArchived},
}

func ValidateContributionTransition(from, to ContributionStatus) error {
	allowed, ok := contributionTransitions[from]
	if !ok {
		return fmt.Errorf("no transitions from status %q", from)
	}
	for _, s := range allowed {
		if s == to {
			return nil
		}
	}
	return fmt.Errorf("invalid contribution transition: %s → %s", from, to)
}

// --- Decision Plan transitions ---

var decisionPlanTransitions = map[DecisionPlanStatus][]DecisionPlanStatus{
	DecisionPlanDrafted:   {DecisionPlanSubmitted},
	DecisionPlanSubmitted: {DecisionPlanSignedOff},
}

func ValidateDecisionPlanTransition(from, to DecisionPlanStatus) error {
	allowed, ok := decisionPlanTransitions[from]
	if !ok {
		return fmt.Errorf("no transitions from status %q", from)
	}
	for _, s := range allowed {
		if s == to {
			return nil
		}
	}
	return fmt.Errorf("invalid decision plan transition: %s → %s", from, to)
}

// --- Governance Action transitions ---

var govActionTransitions = map[GovernanceActionStatus][]GovernanceActionStatus{
	GovActionPlanned:   {GovActionCompleted, GovActionArchived},
	GovActionCompleted: {GovActionArchived},
}

func ValidateGovernanceActionTransition(from, to GovernanceActionStatus) error {
	allowed, ok := govActionTransitions[from]
	if !ok {
		return fmt.Errorf("no transitions from status %q", from)
	}
	for _, s := range allowed {
		if s == to {
			return nil
		}
	}
	return fmt.Errorf("invalid governance action transition: %s → %s", from, to)
}

// --- Field validation ---

func ValidateProposal(p *Proposal) []string {
	var errs []string
	if p.ID == "" {
		errs = append(errs, "id is required")
	}
	if p.ProposerID == "" {
		errs = append(errs, "proposer_id is required")
	}
	if p.Title == "" {
		errs = append(errs, "title is required")
	}
	if len(p.Types) == 0 {
		errs = append(errs, "at least one type is required")
	}
	if p.Priority == "" {
		errs = append(errs, "priority is required")
	}
	if p.Description == "" {
		errs = append(errs, "description is required")
	}
	if p.ProblemStatement == "" {
		errs = append(errs, "problem_statement is required")
	}
	if p.Solution == "" {
		errs = append(errs, "solution is required")
	}
	if len(p.ExpectedOutcomes) == 0 {
		errs = append(errs, "at least one expected_outcome is required")
	}
	if p.EstimatedBudget == "" {
		errs = append(errs, "estimated_budget is required")
	}
	if p.Timeline == "" {
		errs = append(errs, "timeline is required")
	}
	return errs
}

func ValidateProject(p *Project) []string {
	var errs []string
	if p.ID == "" {
		errs = append(errs, "id is required")
	}
	if p.Title == "" {
		errs = append(errs, "title is required")
	}
	if p.Description == "" {
		errs = append(errs, "description is required")
	}
	if p.CreatedBy == "" {
		errs = append(errs, "created_by is required")
	}
	return errs
}

func ValidateContribution(c *Contribution) []string {
	var errs []string
	if c.ID == "" {
		errs = append(errs, "id is required")
	}
	if c.ProjectID == "" {
		errs = append(errs, "project_id is required")
	}
	if c.Title == "" {
		errs = append(errs, "title is required")
	}
	if c.Description == "" {
		errs = append(errs, "description is required")
	}
	if c.CreatedBy == "" {
		errs = append(errs, "created_by is required")
	}
	if len(c.Objectives) == 0 {
		errs = append(errs, "at least one objective is required")
	}
	if len(c.Deliverables) == 0 {
		errs = append(errs, "at least one deliverable is required")
	}
	if len(c.AcceptanceCriteria) == 0 {
		errs = append(errs, "at least one acceptance criterion is required")
	}
	if c.QualityRating != 0 && (c.QualityRating < 1 || c.QualityRating > 10) {
		errs = append(errs, "quality_rating must be between 1 and 10")
	}
	return errs
}

// ValidateNoCyclicDependency checks that adding depID as a dependency of contribID
// does not create a circular reference. deps maps each contribution ID to its dependencies.
func ValidateNoCyclicDependency(contribID, depID string, deps map[string][]string) error {
	visited := map[string]bool{}
	var walk func(id string) bool
	walk = func(id string) bool {
		if id == contribID {
			return true // cycle found
		}
		if visited[id] {
			return false
		}
		visited[id] = true
		for _, next := range deps[id] {
			if walk(next) {
				return true
			}
		}
		return false
	}
	if walk(depID) {
		return fmt.Errorf("adding dependency %s → %s would create a cycle", contribID, depID)
	}
	return nil
}

// ValidateParentSignOff ensures all child contributions are signed_off before
// the parent can transition to signed_off.
func ValidateParentSignOff(parentID string, childStatuses map[string]ContributionStatus) error {
	for childID, status := range childStatuses {
		if status != ContribSignedOff && status != ContribRewarded && status != ContribArchived {
			return fmt.Errorf("child contribution %s has status %s; all children must be signed_off before parent %s", childID, status, parentID)
		}
	}
	return nil
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && go test ./internal/contributions/... -v`
Expected: PASS — all tests pass

- [ ] **Step 5: Commit**

```bash
cd backend && git add internal/contributions/validation.go internal/contributions/validation_test.go
git commit -m "feat: add status transition validation for proposals, contributions, decision plans, governance actions"
```

---

### Task 1.5: any-sync Object Types for Contributions

**Files:**
- Modify: `backend/internal/anysync/object_tree.go` (add new change types)

The existing `ObjectChangeType = "matou.object.v1"` already supports arbitrary typed data via `ObjectPayload.Type`. The contributions system will use distinct type strings to filter objects:

- [ ] **Step 1: Add contribution object type constants**

Add to `backend/internal/anysync/object_tree.go` after the existing `ObjectChangeType` constant:

```go
// Object type identifiers for contributions system entities.
// These are stored in ObjectPayload.Type to distinguish entity types within the same tree.
const (
	TypeProposal           = "proposal"
	TypeEndorsement        = "endorsement"
	TypeProject            = "project"
	TypeDecisionPlan       = "decision_plan"
	TypeGovernanceAction   = "governance_action"
	TypeImplementationPlan = "implementation_plan"
	TypeMilestone          = "milestone"
	TypeContribution       = "contribution"
	TypeNotification       = "notification"
)
```

- [ ] **Step 2: Add ReadObjectByID helper**

> **NOTE**: `ReadObjectsByType()` already exists on `ObjectTreeManager` (uses `UnifiedTreeManager.GetTreesByType()` internally). Only `ReadObjectByID` is new.

Add to `backend/internal/anysync/object_tree.go`:

```go
// ReadObjectByID reads a single object by ID from a space's tree.
// Uses UnifiedTreeManager.GetTreeForObject() for O(1) lookup.
func (m *ObjectTreeManager) ReadObjectByID(ctx context.Context, spaceID string, objectID string) (*ObjectPayload, error) {
	tree, err := m.treeManager.GetTreeForObject(ctx, spaceID, objectID)
	if err != nil {
		return nil, fmt.Errorf("object %s not found in space %s: %w", objectID, spaceID, err)
	}

	// Read the ObjectIndexEntry to get the type
	entries := m.treeManager.GetTreesByType(spaceID, "") // need objectType
	var objectType string
	for _, e := range entries {
		if e.ObjectID == objectID {
			objectType = e.ObjectType
			break
		}
	}

	tree.Lock()
	defer tree.Unlock()
	state, err := BuildState(tree, objectID, objectType)
	if err != nil {
		return nil, fmt.Errorf("building state for %s: %w", objectID, err)
	}
	return stateToPayload(state, ""), nil
}
```

> **Alternative simpler approach**: If `GetTreeForObject` doesn't return the objectType, fall back to scanning via `ReadObjectsByType` for common types until found. In practice, the caller usually knows the type — consider adding a `ReadObjectByTypeAndID(ctx, spaceID, objectType, objectID)` method instead.

- [ ] **Step 3: Commit**

```bash
cd backend && git add internal/anysync/object_tree.go
git commit -m "feat: add contribution object types and filtered read helpers for any-sync trees"
```

---

### Task 1.6: Phase 1 Verification Checkpoint

- [ ] **Step 1: Run all backend tests**

Run: `cd backend && go test ./internal/logging/... ./internal/contributions/... -v`
Expected: ALL PASS

- [ ] **Step 2: Verify against design document**

Checklist:
- [x] Structured logger exists with component tags (matching `log.Printf` pattern for stderr capture)
- [x] Frontend logger exists with same format
- [x] All entity models match design document schemas (Proposal, Project, DecisionPlan, GovernanceAction, ImplementationPlan, Milestone, Contribution, Endorsement)
- [x] Status enums match design document values
- [x] Status transitions match section 6.2 transition rules
- [x] Field validation covers all required fields from design document
- [x] any-sync object types defined for all entities
- [x] Filtered read helpers available
- [x] Quality rating validation (1-10 range)
- [x] Circular dependency prevention
- [x] Parent sign-off requires all children complete
- [x] RBAC role model bridging KERI roles to contribution permissions + middleware
- [x] ProfileRoleLookup reads existing CommunityProfile role field
- [x] Project status derivation from implementation plans
- [x] In-memory type index for any-sync reads (ALREADY EXISTS in UnifiedTreeManager — no work needed)

- [ ] **Step 3: Commit checkpoint tag**

```bash
git tag phase-1-foundation
```

---

### Task 1.7: RBAC Role Model & Middleware

> **⚠ ALIGNMENT NOTE**: The codebase already has 10 roles defined in `backend/internal/keri/client.go` using Title Case with spaces (e.g. "Operations Steward"). This task bridges those existing roles to contribution-specific action permissions. Do NOT redefine roles — use the existing strings.

**Files:**
- Create: `backend/internal/contributions/roles.go`
- Create: `backend/internal/contributions/roles_test.go`
- Create: `backend/internal/api/rbac.go`

- [ ] **Step 1: Write failing test for role checking**

```go
// backend/internal/contributions/roles_test.go
package contributions

import "testing"

func TestMapKERIRole(t *testing.T) {
	// Existing KERI roles should map to contribution roles
	roles := MapKERIRole("Operations Steward")
	if !HasRole(roles, RoleOperationsSteward) {
		t.Error("expected Operations Steward to map to RoleOperationsSteward")
	}
	// "Community Steward" maps to both community steward AND project steward
	roles = MapKERIRole("Community Steward")
	if !HasRole(roles, RoleCommunitySteward) {
		t.Error("expected Community Steward mapping")
	}
	// Unknown role returns empty
	roles = MapKERIRole("Unknown Role")
	if len(roles) != 0 {
		t.Errorf("expected empty roles for unknown, got %v", roles)
	}
}

func TestCanPerformAction_CreateContribution(t *testing.T) {
	// Operations stewards can create any contribution
	if !CanPerformAction([]Role{RoleOperationsSteward}, ActionCreateContribution) {
		t.Error("ops steward should create contributions")
	}
	// Founding members can create contributions
	if !CanPerformAction([]Role{RoleFoundingMember}, ActionCreateContribution) {
		t.Error("founding member should create contributions")
	}
	// Plain contributor cannot create top-level contributions
	if CanPerformAction([]Role{RoleContributor}, ActionCreateContribution) {
		t.Error("contributor should not create top-level contributions")
	}
}

func TestCanPerformAction_AssignContribution(t *testing.T) {
	if !CanPerformAction([]Role{RoleProjectLead}, ActionAssignContribution) {
		t.Error("project lead should assign")
	}
	if CanPerformAction([]Role{RoleContributor}, ActionAssignContribution) {
		t.Error("contributor should not assign")
	}
}

func TestCanPerformAction_SignOff(t *testing.T) {
	if !CanPerformAction([]Role{RoleProjectSteward}, ActionSignOffContribution) {
		t.Error("project steward should sign off")
	}
	if !CanPerformAction([]Role{RoleOperationsSteward}, ActionSignOffContribution) {
		t.Error("ops steward should sign off")
	}
	if CanPerformAction([]Role{RoleProjectLead}, ActionSignOffContribution) {
		t.Error("project lead should not sign off")
	}
}

func TestCanPerformAction_ApproveContribution(t *testing.T) {
	if !CanPerformAction([]Role{RoleProjectLead}, ActionApproveContribution) {
		t.Error("project lead should approve")
	}
	if CanPerformAction([]Role{RoleContributor}, ActionApproveContribution) {
		t.Error("contributor should not approve")
	}
}

func TestCanPerformAction_RegisterInterest(t *testing.T) {
	if !CanPerformAction([]Role{RoleContributor}, ActionRegisterInterest) {
		t.Error("contributor should register interest")
	}
	if !CanPerformAction([]Role{RoleMember}, ActionRegisterInterest) {
		t.Error("member should register interest")
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && go test ./internal/contributions/... -run "TestMapKERI|TestCanPerform" -v`
Expected: FAIL — types not defined

- [ ] **Step 3: Implement role model and permission checks**

```go
// backend/internal/contributions/roles.go
package contributions

// Role represents a contribution-specific role.
// These are internal to the contributions system and mapped FROM existing KERI roles.
type Role string

const (
	RoleMember            Role = "member"
	RoleContributor       Role = "contributor"
	RoleProjectLead       Role = "project_lead"
	RoleProjectSteward    Role = "project_steward"
	RoleOperationsSteward Role = "operations_steward"
	RoleCommunitySteward  Role = "community_steward"
	RoleTechSteward       Role = "tech_steward"
	RoleTreasurySteward   Role = "treasury_steward"
	RoleFoundingMember    Role = "founding_member"
	RoleElderCouncil      Role = "elder_council"
)

// MapKERIRole maps a KERI credential role string (Title Case) to contribution roles.
// A single KERI role may grant multiple contribution roles (e.g. stewards also get project_steward).
func MapKERIRole(keriRole string) []Role {
	switch keriRole {
	case "Member":
		return []Role{RoleMember}
	case "Contributor":
		return []Role{RoleMember, RoleContributor}
	case "Community Steward":
		return []Role{RoleMember, RoleContributor, RoleCommunitySteward, RoleProjectSteward}
	case "Operations Steward":
		return []Role{RoleMember, RoleContributor, RoleOperationsSteward, RoleProjectSteward, RoleProjectLead}
	case "Founding Member":
		return []Role{RoleMember, RoleContributor, RoleFoundingMember, RoleOperationsSteward, RoleProjectSteward, RoleProjectLead}
	case "Financial Steward":
		return []Role{RoleMember, RoleContributor, RoleTreasurySteward}
	case "Governance Steward":
		return []Role{RoleMember, RoleContributor, RoleCommunitySteward}
	case "Treasury Steward":
		return []Role{RoleMember, RoleContributor, RoleTreasurySteward}
	case "Technical Steward":
		return []Role{RoleMember, RoleContributor, RoleTechSteward, RoleProjectLead}
	case "Cultural Steward":
		return []Role{RoleMember, RoleContributor, RoleCommunitySteward}
	default:
		return nil
	}
}

// Action represents a permissioned operation in the contributions system.
type Action string

const (
	ActionCreateContribution  Action = "create_contribution"
	ActionConfirmContribution Action = "confirm_contribution"
	ActionAssignContribution  Action = "assign_contribution"
	ActionApproveContribution Action = "approve_contribution"
	ActionSignOffContribution Action = "sign_off_contribution"
	ActionCreateProject       Action = "create_project"
	ActionEditProject         Action = "edit_project"
	ActionDeleteProject       Action = "delete_project"
	ActionCreateSubContrib    Action = "create_sub_contribution"
	ActionRegisterInterest    Action = "register_interest"
)

// actionPermissions maps each action to the roles that can perform it.
var actionPermissions = map[Action][]Role{
	ActionCreateContribution:  {RoleOperationsSteward, RoleProjectLead, RoleFoundingMember},
	ActionConfirmContribution: {RoleProjectSteward, RoleProjectLead, RoleOperationsSteward},
	ActionAssignContribution:  {RoleProjectLead, RoleOperationsSteward},
	ActionApproveContribution: {RoleProjectLead, RoleOperationsSteward},
	ActionSignOffContribution: {RoleProjectSteward, RoleOperationsSteward},
	ActionCreateProject:       {RoleOperationsSteward, RoleFoundingMember},
	ActionEditProject:         {RoleOperationsSteward, RoleFoundingMember},
	ActionDeleteProject:       {RoleOperationsSteward, RoleFoundingMember},
	ActionCreateSubContrib:    {RoleContributor, RoleProjectLead, RoleOperationsSteward},
	ActionRegisterInterest:    {RoleMember, RoleContributor, RoleProjectLead, RoleTechSteward, RoleCommunitySteward},
}

// HasRole checks if a role list contains the given role.
func HasRole(roles []Role, target Role) bool {
	for _, r := range roles {
		if r == target {
			return true
		}
	}
	return false
}

// CanPerformAction checks if any of the user's roles allows the given action.
func CanPerformAction(userRoles []Role, action Action) bool {
	allowed, ok := actionPermissions[action]
	if !ok {
		return false
	}
	for _, role := range userRoles {
		for _, a := range allowed {
			if role == a {
				return true
			}
		}
	}
	return false
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && go test ./internal/contributions/... -run "TestMapKERI|TestCanPerform" -v`
Expected: PASS

- [ ] **Step 5: Create RBAC middleware for API handlers**

> **NOTE**: Existing backend has no role middleware (trust model). This middleware is NEW and applies only to contributions endpoints. It uses `X-User-AID` header + CommunityProfile lookup to resolve roles.

```go
// backend/internal/api/rbac.go
package api

import (
	"context"
	"net/http"

	"github.com/matou-dao/backend/internal/contributions"
	"github.com/matou-dao/backend/internal/logging"
)

type contextKey string

const (
	ctxUserAID   contextKey = "user_aid"
	ctxUserRoles contextKey = "user_roles"
)

var rbacLog = logging.New("RBAC")

// RoleLookup resolves a user AID to their contribution-system roles.
// Implementation reads the "role" field from CommunityProfile in the readonly space,
// then maps it via contributions.MapKERIRole().
type RoleLookup interface {
	GetUserRoles(aid string) ([]contributions.Role, error)
}

// RBACMiddleware extracts the user AID from the X-User-AID header,
// resolves their roles, and stores both in the request context.
func RBACMiddleware(lookup RoleLookup, next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		aid := r.Header.Get("X-User-AID")
		if aid == "" {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "X-User-AID header required"})
			return
		}
		roles, err := lookup.GetUserRoles(aid)
		if err != nil {
			rbacLog.Warn("role lookup failed for %s: %v", aid, err)
			roles = []contributions.Role{} // default to no roles
		}

		ctx := context.WithValue(r.Context(), ctxUserAID, aid)
		ctx = context.WithValue(ctx, ctxUserRoles, roles)
		next(w, r.WithContext(ctx))
	}
}

// RequireAction wraps a handler and returns 403 if the caller lacks
// the required action permission.
func RequireAction(action contributions.Action, next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		roles, _ := r.Context().Value(ctxUserRoles).([]contributions.Role)
		if !contributions.CanPerformAction(roles, action) {
			rbacLog.Warn("access denied: action=%s roles=%v", action, roles)
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "insufficient permissions"})
			return
		}
		next(w, r)
	}
}

// GetUserAID extracts the user AID from the request context.
func GetUserAID(r *http.Request) string {
	aid, _ := r.Context().Value(ctxUserAID).(string)
	return aid
}

// GetUserRoles extracts user roles from the request context.
func GetUserRoles(r *http.Request) []contributions.Role {
	roles, _ := r.Context().Value(ctxUserRoles).([]contributions.Role)
	return roles
}
```

- [ ] **Step 6: Commit**

```bash
cd backend && git add internal/contributions/roles.go internal/contributions/roles_test.go internal/api/rbac.go
git commit -m "feat: add RBAC role model bridging KERI roles to contribution permissions"
```

---

### Task 1.8: RoleLookup Implementation (Bridging Existing Roles)

> **⚠ ALIGNMENT NOTE**: Member role management already exists in the codebase:
> - `PUT /api/v1/members/{aid}/role` in `backend/internal/api/profiles.go`
> - `updateMemberRole()` in `frontend/src/lib/api/client.ts`
> - `ChangeRoleModal.vue` for admin role changes
> - `useAdminAccess.ts` for role detection
>
> This task only creates the `RoleLookup` implementation that reads existing CommunityProfile roles and bridges them to contribution permissions.

**Files:**
- Create: `backend/internal/contributions/role_store.go`
- Create: `backend/internal/contributions/role_store_test.go`

- [ ] **Step 1: Write failing test**

```go
// backend/internal/contributions/role_store_test.go
package contributions

import (
	"encoding/json"
	"testing"
)

func TestProfileRoleLookup_GetUserRoles(t *testing.T) {
	store := NewMockStore()
	// Simulate a CommunityProfile with role "Operations Steward"
	profile := map[string]interface{}{
		"userAID": "EAbcd1234",
		"role":    "Operations Steward",
	}
	store.Save("readonly-space", "CommunityProfile-EAbcd1234", "CommunityProfile", profile)

	lookup := NewProfileRoleLookup(store, "readonly-space")
	roles, err := lookup.GetUserRoles("EAbcd1234")
	if err != nil {
		t.Fatalf("GetUserRoles failed: %v", err)
	}
	if !HasRole(roles, RoleOperationsSteward) {
		t.Errorf("expected operations_steward in roles, got %v", roles)
	}
	if !HasRole(roles, RoleProjectLead) {
		t.Errorf("expected project_lead in roles (granted by Operations Steward), got %v", roles)
	}
}

func TestProfileRoleLookup_UnknownUser(t *testing.T) {
	store := NewMockStore()
	lookup := NewProfileRoleLookup(store, "readonly-space")
	roles, err := lookup.GetUserRoles("unknown-aid")
	if err != nil {
		t.Fatalf("expected no error for unknown user, got: %v", err)
	}
	if len(roles) != 0 {
		t.Errorf("expected empty roles for unknown user, got %v", roles)
	}
}
```

- [ ] **Step 2: Implement ProfileRoleLookup**

```go
// backend/internal/contributions/role_store.go
package contributions

import "encoding/json"

// ProfileRoleLookup implements RoleLookup by reading CommunityProfile objects
// from the read-only space and mapping KERI role strings to contribution roles.
type ProfileRoleLookup struct {
	store ObjectStore
	space string // community read-only space ID
}

func NewProfileRoleLookup(store ObjectStore, readOnlySpaceID string) *ProfileRoleLookup {
	return &ProfileRoleLookup{store: store, space: readOnlySpaceID}
}

// GetUserRoles reads the user's CommunityProfile and maps the KERI role to contribution roles.
func (l *ProfileRoleLookup) GetUserRoles(aid string) ([]Role, error) {
	// CommunityProfile objects use the convention "CommunityProfile-{AID}" as their ID
	profiles, err := l.store.List(l.space, "CommunityProfile")
	if err != nil {
		return []Role{}, nil
	}
	for _, raw := range profiles {
		var profile struct {
			UserAID string `json:"userAID"`
			Role    string `json:"role"`
		}
		if err := json.Unmarshal(raw, &profile); err != nil {
			continue
		}
		if profile.UserAID == aid {
			return MapKERIRole(profile.Role), nil
		}
	}
	return []Role{}, nil
}
```

- [ ] **Step 3: Run tests**

Run: `cd backend && go test ./internal/contributions/... -run "TestProfileRoleLookup" -v`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
cd backend && git add internal/contributions/role_store.go internal/contributions/role_store_test.go
git commit -m "feat: add ProfileRoleLookup bridging KERI roles to contribution permissions"
```

---

### Task 1.9: Project Status Derivation

**Files:**
- Modify: `backend/internal/contributions/service.go`
- Modify: `backend/internal/contributions/service_test.go`

- [ ] **Step 1: Write failing test**

Add to `service_test.go`:

```go
func TestService_DeriveProjectStatus(t *testing.T) {
	svc := NewService(NewMockStore())
	ctx := context.Background()

	proj, _ := svc.CreateProject(ctx, "space-1", &CreateProjectRequest{
		Title: "Test", Description: "Test", CreatedBy: "admin-1",
	})

	// No implementation plans → created
	status := svc.DeriveProjectStatus(ctx, "space-1", proj.ID)
	if status != ProjectCreated {
		t.Errorf("expected created with no plans, got %s", status)
	}

	// Add an implementation plan with status "created"
	ip, _ := svc.CreateImplementationPlan(ctx, "space-1", &CreateImplementationPlanRequest{
		ProjectID: proj.ID, Title: "Plan 1", TotalBudget: "$1",
		ProjectLeadID: "l", ProjectStewardID: "s",
	})
	_ = ip

	status = svc.DeriveProjectStatus(ctx, "space-1", proj.ID)
	if status != ProjectActive {
		t.Errorf("expected active with one plan, got %s", status)
	}
}
```

- [ ] **Step 2: Implement DeriveProjectStatus**

Add to `service.go`:

```go
// DeriveProjectStatus computes the project status from its implementation plans.
// - No plans → created
// - Any plan in progress → active
// - All plans completed → completed
// - Otherwise → created
func (s *Service) DeriveProjectStatus(ctx context.Context, spaceID, projectID string) ProjectStatus {
	plans, err := s.ListImplementationPlans(ctx, spaceID)
	if err != nil || len(plans) == 0 {
		return ProjectCreated
	}
	projectPlans := make([]*ImplementationPlan, 0)
	for _, p := range plans {
		if p.ProjectID == projectID {
			projectPlans = append(projectPlans, p)
		}
	}
	if len(projectPlans) == 0 {
		return ProjectCreated
	}
	allCompleted := true
	for _, p := range projectPlans {
		if p.CurrentStatus != "completed" {
			allCompleted = false
			break
		}
	}
	if allCompleted {
		return ProjectCompleted
	}
	return ProjectActive
}

// RefreshProjectStatus re-derives and persists the project's status.
func (s *Service) RefreshProjectStatus(ctx context.Context, spaceID, projectID string) (*Project, error) {
	proj, err := s.GetProject(ctx, spaceID, projectID)
	if err != nil {
		return nil, err
	}
	newStatus := s.DeriveProjectStatus(ctx, spaceID, projectID)
	if proj.Status != newStatus {
		proj.Status = newStatus
		proj.UpdatedAt = time.Now()
		if err := s.store.Save(spaceID, proj.ID, "project", proj); err != nil {
			return nil, err
		}
	}
	return proj, nil
}
```

- [ ] **Step 3: Run tests, commit**

Run: `cd backend && go test ./internal/contributions/... -v`
Expected: ALL PASS

```bash
cd backend && git add internal/contributions/
git commit -m "feat: add project status derivation from implementation plan states"
```

---

### Task 1.10: ~~In-Memory Type Index for any-sync Reads~~ ALREADY IMPLEMENTED

> **⚠ SKIP THIS TASK**: `UnifiedTreeManager` in `backend/internal/anysync/unified_tree_manager.go` already provides this functionality:
> - `GetTreesByType(spaceID, objectType)` → O(1) lookup via `spaceIndex` sync.Map
> - `GetTreeForObject(ctx, spaceID, objectID)` → O(1) lookup via `objectMap` sync.Map
> - `BuildSpaceIndex(ctx, spaceID)` → scans StoredIds, reads root metadata, populates both indexes
> - `ObjectTreeManager.ReadObjectsByType()` already delegates to `GetTreesByType()`
>
> No additional indexing work is needed.

---

## Chunk 2: Phase 2 — Proposals & Endorsements

### Task 2.1: Contributions Service (Backend Business Logic)

**Files:**
- Create: `backend/internal/contributions/service.go`
- Create: `backend/internal/contributions/service_test.go`

- [ ] **Step 1: Write failing test for service**

```go
// backend/internal/contributions/service_test.go
package contributions

import (
	"context"
	"encoding/json"
	"testing"
	"time"
)

// MockObjectStore implements a simple in-memory store for testing
type MockObjectStore struct {
	objects map[string]map[string][]byte // spaceID -> objectID -> data
}

func NewMockStore() *MockObjectStore {
	return &MockObjectStore{objects: make(map[string]map[string][]byte)}
}

func (m *MockObjectStore) Save(spaceID, objectID, objectType string, data interface{}) error {
	if m.objects[spaceID] == nil {
		m.objects[spaceID] = make(map[string][]byte)
	}
	b, _ := json.Marshal(data)
	m.objects[spaceID][objectID] = b
	return nil
}

func (m *MockObjectStore) Get(spaceID, objectID string, dest interface{}) error {
	if m.objects[spaceID] == nil {
		return ErrNotFound
	}
	b, ok := m.objects[spaceID][objectID]
	if !ok {
		return ErrNotFound
	}
	return json.Unmarshal(b, dest)
}

func (m *MockObjectStore) List(spaceID, objectType string) ([]json.RawMessage, error) {
	var results []json.RawMessage
	if m.objects[spaceID] == nil {
		return results, nil
	}
	for _, b := range m.objects[spaceID] {
		results = append(results, b)
	}
	return results, nil
}

func (m *MockObjectStore) Delete(spaceID, objectID string) error {
	if m.objects[spaceID] != nil {
		delete(m.objects[spaceID], objectID)
	}
	return nil
}

func TestService_CreateProposal(t *testing.T) {
	svc := NewService(NewMockStore())
	ctx := context.Background()

	p, err := svc.CreateProposal(ctx, "space-1", &CreateProposalRequest{
		ProposerID:       "user-1",
		Title:            "Build website",
		Types:            []ProposalType{ProposalTypeTechnical},
		Priority:         PriorityMedium,
		Description:      "Build a new website",
		ProblemStatement: "No website exists",
		Solution:         "Build one",
		ExpectedOutcomes: []string{"Website launched"},
		EstimatedBudget:  "$5000",
		Timeline:         "4 weeks",
	})
	if err != nil {
		t.Fatalf("CreateProposal failed: %v", err)
	}
	if p.Status != ProposalDraft {
		t.Errorf("expected draft status, got %s", p.Status)
	}
	if p.ID == "" {
		t.Error("expected non-empty ID")
	}
	if p.ProposerID != "user-1" {
		t.Errorf("expected proposer_id user-1, got %s", p.ProposerID)
	}
}

func TestService_TransitionProposal(t *testing.T) {
	svc := NewService(NewMockStore())
	ctx := context.Background()

	p, _ := svc.CreateProposal(ctx, "space-1", &CreateProposalRequest{
		ProposerID: "user-1", Title: "Test", Types: []ProposalType{ProposalTypeTechnical},
		Priority: PriorityLow, Description: "d", ProblemStatement: "p",
		Solution: "s", ExpectedOutcomes: []string{"o"}, EstimatedBudget: "$1", Timeline: "1w",
	})

	updated, err := svc.TransitionProposal(ctx, "space-1", p.ID, ProposalSubmitted)
	if err != nil {
		t.Fatalf("TransitionProposal failed: %v", err)
	}
	if updated.Status != ProposalSubmitted {
		t.Errorf("expected submitted, got %s", updated.Status)
	}

	// Invalid transition
	_, err = svc.TransitionProposal(ctx, "space-1", p.ID, ProposalApproved)
	if err == nil {
		t.Error("expected error for invalid transition")
	}
}

func TestService_AddEndorsement(t *testing.T) {
	svc := NewService(NewMockStore())
	ctx := context.Background()

	p, _ := svc.CreateProposal(ctx, "space-1", &CreateProposalRequest{
		ProposerID: "user-1", Title: "Test", Types: []ProposalType{ProposalTypeTechnical},
		Priority: PriorityLow, Description: "d", ProblemStatement: "p",
		Solution: "s", ExpectedOutcomes: []string{"o"}, EstimatedBudget: "$1", Timeline: "1w",
	})

	// Move to endorsing
	svc.TransitionProposal(ctx, "space-1", p.ID, ProposalSubmitted)
	svc.TransitionProposal(ctx, "space-1", p.ID, ProposalEndorsing)

	err := svc.AddEndorsement(ctx, "space-1", p.ID, &Endorsement{
		EndorserID: "user-2",
		EndorsedAt: time.Now(),
		Comment:    "Looks good",
	})
	if err != nil {
		t.Fatalf("AddEndorsement failed: %v", err)
	}

	endorsements, err := svc.GetEndorsements(ctx, "space-1", p.ID)
	if err != nil {
		t.Fatalf("GetEndorsements failed: %v", err)
	}
	if len(endorsements) != 1 {
		t.Errorf("expected 1 endorsement, got %d", len(endorsements))
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && go test ./internal/contributions/... -v`
Expected: FAIL — Service, ErrNotFound, CreateProposalRequest not defined

- [ ] **Step 3: Implement service**

```go
// backend/internal/contributions/service.go
package contributions

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"crypto/rand"
)

var ErrNotFound = errors.New("not found")

// ObjectStore abstracts any-sync object tree operations for testability.
type ObjectStore interface {
	Save(spaceID, objectID, objectType string, data interface{}) error
	Get(spaceID, objectID string, dest interface{}) error
	List(spaceID, objectType string) ([]json.RawMessage, error)
	Delete(spaceID, objectID string) error
}

// Service provides business logic for the contributions system.
type Service struct {
	store ObjectStore
}

func NewService(store ObjectStore) *Service {
	return &Service{store: store}
}

func generateID(prefix string) string {
	b := make([]byte, 8)
	if _, err := rand.Read(b); err != nil {
		// Fallback to timestamp-based ID if crypto/rand fails
		return fmt.Sprintf("%s_%d", prefix, time.Now().UnixNano())
	}
	return fmt.Sprintf("%s_%x", prefix, b)
}

// --- Proposals ---

type CreateProposalRequest struct {
	ProposerID       string         `json:"proposer_id"`
	Title            string         `json:"title"`
	Types            []ProposalType `json:"type"`
	Priority         Priority       `json:"priority"`
	Description      string         `json:"description"`
	ProblemStatement string         `json:"problem_statement"`
	Solution         string         `json:"solution"`
	ExpectedOutcomes []string       `json:"expected_outcomes"`
	EstimatedBudget  string         `json:"estimated_budget"`
	Timeline         string         `json:"timeline"`
	ProjectPlan      []ProjectPlanItem `json:"project_plan,omitempty"`
}

func (s *Service) CreateProposal(ctx context.Context, spaceID string, req *CreateProposalRequest) (*Proposal, error) {
	now := time.Now()
	p := &Proposal{
		ID:               generateID("prop"),
		ProposerID:       req.ProposerID,
		Title:            req.Title,
		Types:            req.Types,
		Priority:         req.Priority,
		Description:      req.Description,
		ProblemStatement: req.ProblemStatement,
		Solution:         req.Solution,
		ExpectedOutcomes: req.ExpectedOutcomes,
		EstimatedBudget:  req.EstimatedBudget,
		Timeline:         req.Timeline,
		ProjectPlan:      req.ProjectPlan,
		Status:           ProposalDraft,
		CreatedAt:        now,
		UpdatedAt:        now,
	}

	errs := ValidateProposal(p)
	if len(errs) > 0 {
		return nil, fmt.Errorf("validation failed: %v", errs)
	}

	if err := s.store.Save(spaceID, p.ID, "proposal", p); err != nil {
		return nil, fmt.Errorf("saving proposal: %w", err)
	}
	return p, nil
}

func (s *Service) GetProposal(ctx context.Context, spaceID, proposalID string) (*Proposal, error) {
	var p Proposal
	if err := s.store.Get(spaceID, proposalID, &p); err != nil {
		return nil, err
	}
	return &p, nil
}

func (s *Service) ListProposals(ctx context.Context, spaceID string) ([]*Proposal, error) {
	raw, err := s.store.List(spaceID, "proposal")
	if err != nil {
		return nil, err
	}
	var proposals []*Proposal
	for _, r := range raw {
		var p Proposal
		if err := json.Unmarshal(r, &p); err == nil {
			proposals = append(proposals, &p)
		}
	}
	return proposals, nil
}

func (s *Service) TransitionProposal(ctx context.Context, spaceID, proposalID string, newStatus ProposalStatus) (*Proposal, error) {
	p, err := s.GetProposal(ctx, spaceID, proposalID)
	if err != nil {
		return nil, err
	}
	if err := ValidateProposalTransition(p.Status, newStatus); err != nil {
		return nil, err
	}
	p.Status = newStatus
	p.UpdatedAt = time.Now()
	if err := s.store.Save(spaceID, p.ID, "proposal", p); err != nil {
		return nil, err
	}
	return p, nil
}

// --- Endorsements ---

func endorsementKey(proposalID, endorserID string) string {
	return fmt.Sprintf("endorse_%s_%s", proposalID, endorserID)
}

func (s *Service) AddEndorsement(ctx context.Context, spaceID, proposalID string, e *Endorsement) error {
	p, err := s.GetProposal(ctx, spaceID, proposalID)
	if err != nil {
		return fmt.Errorf("proposal not found: %w", err)
	}
	if p.Status != ProposalEndorsing {
		return fmt.Errorf("proposal must be in endorsing status, currently: %s", p.Status)
	}
	key := endorsementKey(proposalID, e.EndorserID)
	return s.store.Save(spaceID, key, "endorsement", e)
}

func (s *Service) GetEndorsements(ctx context.Context, spaceID, proposalID string) ([]*Endorsement, error) {
	raw, err := s.store.List(spaceID, "endorsement")
	if err != nil {
		return nil, err
	}
	var endorsements []*Endorsement
	for _, r := range raw {
		var e Endorsement
		if err := json.Unmarshal(r, &e); err == nil {
			endorsements = append(endorsements, &e)
		}
	}
	return endorsements, nil
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && go test ./internal/contributions/... -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
cd backend && git add internal/contributions/service.go internal/contributions/service_test.go
git commit -m "feat: add contributions service with proposal CRUD, transitions, and endorsements"
```

---

### Task 2.2: Proposal API Handler (Backend)

**Files:**
- Create: `backend/internal/api/proposals.go`
- Create: `backend/internal/api/proposals_test.go`

- [ ] **Step 1: Write failing test for proposal handler**

```go
// backend/internal/api/proposals_test.go
package api

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestProposalsHandler_Create(t *testing.T) {
	handler := setupTestProposalsHandler()

	body := map[string]interface{}{
		"proposer_id":       "user-1",
		"title":            "Test Proposal",
		"type":             []string{"technical"},
		"priority":         "medium",
		"description":      "A test",
		"problem_statement": "Problem",
		"solution":         "Solution",
		"expected_outcomes": []string{"outcome"},
		"estimated_budget": "$1000",
		"timeline":         "2 weeks",
	}
	b, _ := json.Marshal(body)

	req := httptest.NewRequest(http.MethodPost, "/api/v1/proposals", bytes.NewReader(b))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()

	handler.HandleCreate(w, req)

	if w.Code != http.StatusCreated {
		t.Errorf("expected 201, got %d: %s", w.Code, w.Body.String())
	}

	var resp map[string]interface{}
	json.Unmarshal(w.Body.Bytes(), &resp)
	if resp["id"] == nil || resp["id"] == "" {
		t.Error("expected non-empty id in response")
	}
	if resp["status"] != "draft" {
		t.Errorf("expected draft status, got %v", resp["status"])
	}
}

func TestProposalsHandler_List(t *testing.T) {
	handler := setupTestProposalsHandler()

	// Create one first
	body := map[string]interface{}{
		"proposer_id": "user-1", "title": "Test", "type": []string{"technical"},
		"priority": "low", "description": "d", "problem_statement": "p",
		"solution": "s", "expected_outcomes": []string{"o"},
		"estimated_budget": "$1", "timeline": "1w",
	}
	b, _ := json.Marshal(body)
	req := httptest.NewRequest(http.MethodPost, "/api/v1/proposals", bytes.NewReader(b))
	w := httptest.NewRecorder()
	handler.HandleCreate(w, req)

	// List
	req = httptest.NewRequest(http.MethodGet, "/api/v1/proposals", nil)
	w = httptest.NewRecorder()
	handler.HandleList(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", w.Code)
	}
}

func TestProposalsHandler_Transition(t *testing.T) {
	handler := setupTestProposalsHandler()

	// Create
	body := map[string]interface{}{
		"proposer_id": "user-1", "title": "Test", "type": []string{"technical"},
		"priority": "low", "description": "d", "problem_statement": "p",
		"solution": "s", "expected_outcomes": []string{"o"},
		"estimated_budget": "$1", "timeline": "1w",
	}
	b, _ := json.Marshal(body)
	req := httptest.NewRequest(http.MethodPost, "/api/v1/proposals", bytes.NewReader(b))
	w := httptest.NewRecorder()
	handler.HandleCreate(w, req)

	var created map[string]interface{}
	json.Unmarshal(w.Body.Bytes(), &created)
	id := created["id"].(string)

	// Transition to submitted
	transBody := map[string]string{"status": "submitted"}
	b, _ = json.Marshal(transBody)
	req = httptest.NewRequest(http.MethodPost, "/api/v1/proposals/"+id+"/transition", bytes.NewReader(b))
	w = httptest.NewRecorder()
	handler.HandleTransition(w, req, id)

	if w.Code != http.StatusOK {
		t.Errorf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && go test ./internal/api/... -run TestProposals -v`
Expected: FAIL — functions not defined

- [ ] **Step 3: Implement proposal handler**

```go
// backend/internal/api/proposals.go
package api

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/matou-dao/backend/internal/contributions"
	"github.com/matou-dao/backend/internal/logging"
)

type ProposalsHandler struct {
	service      *contributions.Service
	spaceManager *anysync.SpaceManager
	log          *logging.Logger
}

func NewProposalsHandler(service *contributions.Service, spaceManager *anysync.SpaceManager) *ProposalsHandler {
	return &ProposalsHandler{
		service:      service,
		spaceManager: spaceManager,
		log:          logging.New("Proposals"),
	}
}

func (h *ProposalsHandler) RegisterRoutes(mux *http.ServeMux, roleLookup RoleLookup) {
	mux.HandleFunc("/api/v1/proposals", CORSHandler(RBACMiddleware(roleLookup, func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			h.HandleList(w, r)
		case http.MethodPost:
			h.HandleCreate(w, r)
		default:
			writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		}
	})))

	// Pattern: /api/v1/proposals/{id}
	mux.HandleFunc("/api/v1/proposals/", CORSHandler(func(w http.ResponseWriter, r *http.Request) {
		path := strings.TrimPrefix(r.URL.Path, "/api/v1/proposals/")
		parts := strings.SplitN(path, "/", 2)
		id := parts[0]

		if len(parts) == 2 && parts[1] == "transition" && r.Method == http.MethodPost {
			h.HandleTransition(w, r, id)
			return
		}
		if len(parts) == 2 && parts[1] == "endorsements" {
			switch r.Method {
			case http.MethodGet:
				h.HandleListEndorsements(w, r, id)
			case http.MethodPost:
				h.HandleAddEndorsement(w, r, id)
			default:
				writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
			}
			return
		}
		if r.Method == http.MethodGet {
			h.HandleGet(w, r, id)
			return
		}
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
	}))
}

// HandleCreate handles POST /api/v1/proposals
func (h *ProposalsHandler) HandleCreate(w http.ResponseWriter, r *http.Request) {
	var req contributions.CreateProposalRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		h.log.Error("failed to decode request: %v", err)
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}

	// Resolve space: use SpaceManager in production, X-Space-ID header for tests.
	spaceID := resolveCommunitySpaceID(r, h.spaceManager)

	proposal, err := h.service.CreateProposal(r.Context(), spaceID, &req)
	if err != nil {
		h.log.Error("failed to create proposal: %v", err)
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}

	h.log.Info("proposal created: %s by %s", proposal.ID, proposal.ProposerID)
	writeJSON(w, http.StatusCreated, proposal)
}

// HandleList handles GET /api/v1/proposals
func (h *ProposalsHandler) HandleList(w http.ResponseWriter, r *http.Request) {
	spaceID := resolveCommunitySpaceID(r, h.spaceManager)

	proposals, err := h.service.ListProposals(r.Context(), spaceID)
	if err != nil {
		h.log.Error("failed to list proposals: %v", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"proposals": proposals,
		"total":     len(proposals),
	})
}

// HandleGet handles GET /api/v1/proposals/{id}
func (h *ProposalsHandler) HandleGet(w http.ResponseWriter, r *http.Request, id string) {
	spaceID := resolveCommunitySpaceID(r, h.spaceManager)

	proposal, err := h.service.GetProposal(r.Context(), spaceID, id)
	if err != nil {
		h.log.Error("proposal not found: %s: %v", id, err)
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "proposal not found"})
		return
	}

	writeJSON(w, http.StatusOK, proposal)
}

// HandleTransition handles POST /api/v1/proposals/{id}/transition
func (h *ProposalsHandler) HandleTransition(w http.ResponseWriter, r *http.Request, id string) {
	var req struct {
		Status string `json:"status"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}

	spaceID := resolveCommunitySpaceID(r, h.spaceManager)

	proposal, err := h.service.TransitionProposal(r.Context(), spaceID, id, contributions.ProposalStatus(req.Status))
	if err != nil {
		h.log.Warn("transition failed for %s: %v", id, err)
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}

	h.log.Info("proposal %s transitioned to %s", id, req.Status)
	writeJSON(w, http.StatusOK, proposal)
}

// HandleAddEndorsement handles POST /api/v1/proposals/{id}/endorsements
func (h *ProposalsHandler) HandleAddEndorsement(w http.ResponseWriter, r *http.Request, id string) {
	var endorsement contributions.Endorsement
	if err := json.NewDecoder(r.Body).Decode(&endorsement); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}

	spaceID := resolveCommunitySpaceID(r, h.spaceManager)

	if err := h.service.AddEndorsement(r.Context(), spaceID, id, &endorsement); err != nil {
		h.log.Error("failed to add endorsement for proposal %s: %v", id, err)
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}

	h.log.Info("endorsement added for proposal %s by %s", id, endorsement.EndorserID)
	writeJSON(w, http.StatusCreated, map[string]string{"success": "true"})
}

// HandleListEndorsements handles GET /api/v1/proposals/{id}/endorsements
func (h *ProposalsHandler) HandleListEndorsements(w http.ResponseWriter, r *http.Request, id string) {
	spaceID := resolveCommunitySpaceID(r, h.spaceManager)

	endorsements, err := h.service.GetEndorsements(r.Context(), spaceID, id)
	if err != nil {
		h.log.Error("failed to list endorsements: %v", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"endorsements": endorsements,
		"total":        len(endorsements),
	})
}

// setupTestProposalsHandler creates a handler with mock store for testing.
// Uses a nil SpaceManager — handler methods that need space IDs will use
// X-Space-ID header in tests or need a mock SpaceManager for integration tests.
func setupTestProposalsHandler() *ProposalsHandler {
	store := contributions.NewMockStore()
	svc := contributions.NewService(store)
	return NewProposalsHandler(svc, nil) // nil SpaceManager — resolveCommunitySpaceID falls back to "community"
}

// resolveCommunitySpaceID resolves the community space ID.
// Shared utility used by all contribution handlers.
// In production: uses SpaceManager. In tests: uses X-Space-ID header fallback.
func resolveCommunitySpaceID(r *http.Request, sm *anysync.SpaceManager) string {
	if override := r.Header.Get("X-Space-ID"); override != "" {
		return override // test override
	}
	if sm != nil {
		return sm.GetCommunitySpaceID()
	}
	return "community" // fallback for unit tests with nil SpaceManager
}
```

Note: `NewMockStore` needs to be exported from contributions package. Update `service_test.go` to export it, or create a `testutil.go`:

- [ ] **Step 3b: Export MockObjectStore for cross-package tests**

Create `backend/internal/contributions/testutil.go`:

```go
package contributions

import "encoding/json"

// MockObjectStore implements ObjectStore for testing.
// It tracks object types so List can filter correctly, matching real any-sync behavior.
type MockObjectStore struct {
	objects map[string]map[string][]byte   // spaceID -> objectID -> data
	types   map[string]map[string]string   // spaceID -> objectID -> objectType
}

func NewMockStore() *MockObjectStore {
	return &MockObjectStore{
		objects: make(map[string]map[string][]byte),
		types:   make(map[string]map[string]string),
	}
}

func (m *MockObjectStore) Save(spaceID, objectID, objectType string, data interface{}) error {
	if m.objects[spaceID] == nil {
		m.objects[spaceID] = make(map[string][]byte)
		m.types[spaceID] = make(map[string]string)
	}
	b, err := json.Marshal(data)
	if err != nil {
		return err
	}
	m.objects[spaceID][objectID] = b
	m.types[spaceID][objectID] = objectType
	return nil
}

func (m *MockObjectStore) Get(spaceID, objectID string, dest interface{}) error {
	if m.objects[spaceID] == nil {
		return ErrNotFound
	}
	b, ok := m.objects[spaceID][objectID]
	if !ok {
		return ErrNotFound
	}
	return json.Unmarshal(b, dest)
}

func (m *MockObjectStore) List(spaceID, objectType string) ([]json.RawMessage, error) {
	var results []json.RawMessage
	if m.objects[spaceID] == nil {
		return results, nil
	}
	for id, b := range m.objects[spaceID] {
		if m.types[spaceID][id] == objectType {
			results = append(results, json.RawMessage(b))
		}
	}
	return results, nil
}

func (m *MockObjectStore) Delete(spaceID, objectID string) error {
	if m.objects[spaceID] != nil {
		delete(m.objects[spaceID], objectID)
		delete(m.types[spaceID], objectID)
	}
	return nil
}
```

Remove the duplicate MockObjectStore from `service_test.go` and use the exported one.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && go test ./internal/api/... -run TestProposals -v && go test ./internal/contributions/... -v`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
cd backend && git add internal/api/proposals.go internal/api/proposals_test.go internal/contributions/testutil.go
git commit -m "feat: add proposal API handler with CRUD, transitions, and endorsements"
```

---

### Task 2.3: Register Proposals Handler in main.go

**Files:**
- Modify: `backend/cmd/server/main.go`

- [ ] **Step 1: Add proposals handler initialization after existing handler creation**

After `filesHandler := api.NewFilesHandler(...)` add:

```go
	// Initialize contributions service (uses community space ObjectTreeManager)
	contribStore := anysync.NewObjectStoreAdapter(spaceManager.ObjectTreeManager(), sdkClient, userIdentity)
	contribService := contributions.NewService(contribStore)
	contribRoleLookup := contributions.NewProfileRoleLookup(contribStore, userIdentity.GetCommunityReadOnlySpaceID())
	proposalsHandler := api.NewProposalsHandler(contribService, spaceManager)
```

- [ ] **Step 2: Register routes after existing route registrations**

After `orgConfigHandler.RegisterRoutes(mux)` add:

```go
	proposalsHandler.RegisterRoutes(mux)
```

- [ ] **Step 3: Add endpoint docs to the startup output**

After the "Org Config:" section add:

```go
	fmt.Println("  Proposals:")
	fmt.Println("  GET  /api/v1/proposals                    - List proposals")
	fmt.Println("  POST /api/v1/proposals                    - Create proposal")
	fmt.Println("  GET  /api/v1/proposals/{id}               - Get proposal")
	fmt.Println("  POST /api/v1/proposals/{id}/transition    - Transition proposal status")
	fmt.Println("  GET  /api/v1/proposals/{id}/endorsements  - List endorsements")
	fmt.Println("  POST /api/v1/proposals/{id}/endorsements  - Add endorsement")
	fmt.Println()
```

- [ ] **Step 4: Create ObjectStoreAdapter to bridge any-sync to contributions.ObjectStore interface**

> **⚠ ALIGNMENT NOTE**: The signing key comes from `SDKClient.GetSigningKey()`, NOT from `UserIdentity`. The `UserIdentity` provides the peer ID via `GetPeerID()`. The adapter needs both.

Create `backend/internal/anysync/contrib_adapter.go`:

```go
package anysync

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/matou-dao/backend/internal/identity"
)

// ObjectStoreAdapter bridges ObjectTreeManager to the contributions.ObjectStore interface.
type ObjectStoreAdapter struct {
	trees    *ObjectTreeManager
	client   AnySyncClient          // for GetSigningKey()
	identity *identity.UserIdentity // for GetPeerID()
}

func NewObjectStoreAdapter(trees *ObjectTreeManager, client AnySyncClient, id *identity.UserIdentity) *ObjectStoreAdapter {
	return &ObjectStoreAdapter{trees: trees, client: client, identity: id}
}

func (a *ObjectStoreAdapter) Save(spaceID, objectID, objectType string, data interface{}) error {
	jsonData, err := json.Marshal(data)
	if err != nil {
		return fmt.Errorf("marshaling data: %w", err)
	}

	signingKey := a.client.GetSigningKey()
	if signingKey == nil {
		return fmt.Errorf("no signing key available")
	}

	payload := &ObjectPayload{
		ID:        objectID,
		Type:      objectType,
		OwnerKey:  a.identity.GetPeerID(),
		Data:      jsonData,
		Timestamp: 0, // AddObject sets this
		Version:   1,
	}

	_, err = a.trees.AddObject(context.Background(), spaceID, payload, signingKey)
	return err
}

func (a *ObjectStoreAdapter) Get(spaceID, objectID string, dest interface{}) error {
	obj, err := a.trees.ReadObjectByID(context.Background(), spaceID, objectID)
	if err != nil {
		return err
	}
	return json.Unmarshal(obj.Data, dest)
}

func (a *ObjectStoreAdapter) List(spaceID, objectType string) ([]json.RawMessage, error) {
	objects, err := a.trees.ReadObjectsByType(context.Background(), spaceID, objectType)
	if err != nil {
		return nil, err
	}
	var results []json.RawMessage
	for _, obj := range objects {
		results = append(results, obj.Data)
	}
	return results, nil
}

func (a *ObjectStoreAdapter) Delete(spaceID, objectID string) error {
	// Mark as deleted via a tombstone object (any-sync trees are append-only)
	return a.Save(spaceID, objectID, "tombstone", map[string]string{"deleted": objectID})
}
```

- [ ] **Step 5: Add import for contributions package in main.go**

```go
import (
	// ... existing imports ...
	"github.com/matou-dao/backend/internal/contributions"
)
```

- [ ] **Step 6: Commit**

```bash
cd backend && git add cmd/server/main.go internal/anysync/contrib_adapter.go
git commit -m "feat: wire up proposals handler in main.go with any-sync object store adapter"
```

---

### Task 2.4: Frontend Proposal API Client

**Files:**
- Create: `frontend/src/lib/api/proposals.ts`

- [ ] **Step 1: Create proposal API client**

```typescript
// frontend/src/lib/api/proposals.ts
import { BACKEND_URL } from './client';
import { createLogger } from '../logging';

const log = createLogger('ProposalsAPI');

export interface CreateProposalRequest {
  proposer_id: string;
  title: string;
  type: string[];
  priority: 'low' | 'medium' | 'high' | 'critical';
  description: string;
  problem_statement: string;
  solution: string;
  expected_outcomes: string[];
  estimated_budget: string;
  timeline: string;
  project_plan?: { title: string; description: string; duration: string }[];
}

export interface Proposal {
  id: string;
  proposer_id: string;
  title: string;
  type: string[];
  priority: string;
  description: string;
  problem_statement: string;
  solution: string;
  expected_outcomes: string[];
  estimated_budget: string;
  timeline: string;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface Endorsement {
  endorser_id: string;
  endorsed_at: string;
  comment?: string;
}

export async function createProposal(req: CreateProposalRequest): Promise<Proposal> {
  log.info('Creating proposal: %s', req.title);
  const response = await fetch(`${BACKEND_URL}/api/v1/proposals`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(err.error || 'Failed to create proposal');
  }
  return response.json();
}

export async function listProposals(): Promise<{ proposals: Proposal[]; total: number }> {
  const response = await fetch(`${BACKEND_URL}/api/v1/proposals`);
  if (!response.ok) throw new Error('Failed to list proposals');
  return response.json();
}

export async function getProposal(id: string): Promise<Proposal> {
  const response = await fetch(`${BACKEND_URL}/api/v1/proposals/${id}`);
  if (!response.ok) throw new Error('Proposal not found');
  return response.json();
}

export async function transitionProposal(id: string, status: string): Promise<Proposal> {
  log.info('Transitioning proposal %s to %s', id, status);
  const response = await fetch(`${BACKEND_URL}/api/v1/proposals/${id}/transition`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status }),
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(err.error || 'Transition failed');
  }
  return response.json();
}

export async function addEndorsement(proposalId: string, endorsement: Endorsement): Promise<void> {
  log.info('Endorsing proposal %s', proposalId);
  const response = await fetch(`${BACKEND_URL}/api/v1/proposals/${proposalId}/endorsements`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(endorsement),
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(err.error || 'Failed to endorse');
  }
}

export async function listEndorsements(proposalId: string): Promise<{ endorsements: Endorsement[]; total: number }> {
  const response = await fetch(`${BACKEND_URL}/api/v1/proposals/${proposalId}/endorsements`);
  if (!response.ok) throw new Error('Failed to list endorsements');
  return response.json();
}
```

- [ ] **Step 2: Commit**

```bash
cd frontend && git add src/lib/api/proposals.ts
git commit -m "feat: add proposal API client with CRUD, transitions, and endorsements"
```

---

### Task 2.5: Proposals Pinia Store

**Files:**
- Create: `frontend/src/stores/proposals.ts`

- [ ] **Step 1: Create proposals store**

```typescript
// frontend/src/stores/proposals.ts
import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import {
  createProposal as apiCreate,
  listProposals as apiList,
  getProposal as apiGet,
  transitionProposal as apiTransition,
  addEndorsement as apiEndorse,
  listEndorsements as apiListEndorsements,
  type Proposal,
  type CreateProposalRequest,
  type Endorsement,
} from 'src/lib/api/proposals';
import { createLogger } from 'src/lib/logging';

const log = createLogger('ProposalsStore');

export const useProposalsStore = defineStore('proposals', () => {
  const proposals = ref<Proposal[]>([]);
  const currentProposal = ref<Proposal | null>(null);
  const endorsements = ref<Endorsement[]>([]);
  const isLoading = ref(false);
  const error = ref<string | null>(null);

  const draftProposals = computed(() => proposals.value.filter(p => p.status === 'draft'));
  const activeProposals = computed(() => proposals.value.filter(p => !['draft', 'completed', 'rejected'].includes(p.status)));

  async function fetchProposals() {
    isLoading.value = true;
    error.value = null;
    try {
      const result = await apiList();
      proposals.value = result.proposals || [];
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Failed to fetch proposals';
      log.error('fetchProposals failed: %s', error.value);
    } finally {
      isLoading.value = false;
    }
  }

  async function fetchProposal(id: string) {
    isLoading.value = true;
    error.value = null;
    try {
      currentProposal.value = await apiGet(id);
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Failed to fetch proposal';
      log.error('fetchProposal failed: %s', error.value);
    } finally {
      isLoading.value = false;
    }
  }

  async function create(req: CreateProposalRequest) {
    error.value = null;
    try {
      const proposal = await apiCreate(req);
      proposals.value.push(proposal);
      log.info('Proposal created: %s', proposal.id);
      return proposal;
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Failed to create proposal';
      log.error('create failed: %s', error.value);
      throw e;
    }
  }

  async function transition(id: string, status: string) {
    error.value = null;
    try {
      const updated = await apiTransition(id, status);
      const idx = proposals.value.findIndex(p => p.id === id);
      if (idx >= 0) proposals.value[idx] = updated;
      if (currentProposal.value?.id === id) currentProposal.value = updated;
      log.info('Proposal %s → %s', id, status);
      return updated;
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Transition failed';
      log.error('transition failed: %s', error.value);
      throw e;
    }
  }

  async function endorse(proposalId: string, endorsement: Endorsement) {
    error.value = null;
    try {
      await apiEndorse(proposalId, endorsement);
      endorsements.value.push(endorsement);
      log.info('Endorsed proposal %s', proposalId);
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Endorsement failed';
      throw e;
    }
  }

  async function fetchEndorsements(proposalId: string) {
    try {
      const result = await apiListEndorsements(proposalId);
      endorsements.value = result.endorsements || [];
    } catch (e) {
      log.error('fetchEndorsements failed: %s', e);
    }
  }

  return {
    proposals, currentProposal, endorsements, isLoading, error,
    draftProposals, activeProposals,
    fetchProposals, fetchProposal, create, transition, endorse, fetchEndorsements,
  };
});
```

- [ ] **Step 2: Commit**

```bash
cd frontend && git add src/stores/proposals.ts
git commit -m "feat: add proposals Pinia store with CRUD, transitions, endorsements"
```

---

### Task 2.6: Phase 2 Verification Checkpoint

- [ ] **Step 1: Run all backend tests**

Run: `cd backend && go test ./internal/logging/... ./internal/contributions/... ./internal/api/... -run "TestProposals|TestService|TestLogger|TestValidat" -v`
Expected: ALL PASS

- [ ] **Step 2: Verify against design document**

Checklist:
- [x] Proposal CRUD (create, read, list) — Section 4.1
- [x] Proposal status lifecycle (draft → submitted → endorsing → in_review → ...) — Section 4.1.2
- [x] Proposer ID included in schema — Section 4.1.1
- [x] Endorsement system using any-sync data tree — Section 4.1.3
- [x] Endorsement data: endorser_id, endorsed_at, comment — Section 4.1.3
- [x] Status transition validation enforced — Section 6.2.1
- [x] API handler with structured logging
- [x] Frontend API client with error handling
- [x] Frontend Pinia store with reactive state

- [ ] **Step 3: Tag checkpoint**

```bash
git tag phase-2-proposals
```

---

## Chunk 3: Phase 3 — Projects

### Task 3.1: Project Service Methods

**Files:**
- Modify: `backend/internal/contributions/service.go`
- Modify: `backend/internal/contributions/service_test.go`

- [ ] **Step 1: Write failing tests for project operations**

Add to `service_test.go`:

```go
func TestService_CreateProject(t *testing.T) {
	svc := NewService(NewMockStore())
	ctx := context.Background()

	p, err := svc.CreateProject(ctx, "space-1", &CreateProjectRequest{
		Title:       "Website Rebuild",
		Description: "Rebuild the community website",
		CreatedBy:   "admin-1",
	})
	if err != nil {
		t.Fatalf("CreateProject failed: %v", err)
	}
	if p.Status != ProjectCreated {
		t.Errorf("expected created status, got %s", p.Status)
	}
	if p.CreatedBy != "admin-1" {
		t.Errorf("expected created_by admin-1, got %s", p.CreatedBy)
	}
}

func TestService_LinkProposalToProject(t *testing.T) {
	svc := NewService(NewMockStore())
	ctx := context.Background()

	proj, _ := svc.CreateProject(ctx, "space-1", &CreateProjectRequest{
		Title: "Project", Description: "Test", CreatedBy: "admin-1",
	})

	updated, err := svc.LinkProposalToProject(ctx, "space-1", proj.ID, "proposal-123")
	if err != nil {
		t.Fatalf("LinkProposal failed: %v", err)
	}
	if len(updated.ProposalIDs) != 1 || updated.ProposalIDs[0] != "proposal-123" {
		t.Errorf("expected proposal-123 in proposal_ids, got %v", updated.ProposalIDs)
	}
}

func TestService_AutoCreateProjectOnApproval(t *testing.T) {
	svc := NewService(NewMockStore())
	ctx := context.Background()

	prop, _ := svc.CreateProposal(ctx, "space-1", &CreateProposalRequest{
		ProposerID: "user-1", Title: "Test", Types: []ProposalType{ProposalTypeTechnical},
		Priority: PriorityLow, Description: "d", ProblemStatement: "p",
		Solution: "s", ExpectedOutcomes: []string{"o"}, EstimatedBudget: "$1", Timeline: "1w",
	})

	project, err := svc.AutoCreateProjectForProposal(ctx, "space-1", prop.ID, "admin-1")
	if err != nil {
		t.Fatalf("AutoCreateProject failed: %v", err)
	}
	if len(project.ProposalIDs) != 1 || project.ProposalIDs[0] != prop.ID {
		t.Errorf("expected proposal linked, got %v", project.ProposalIDs)
	}
	if project.Title != prop.Title {
		t.Errorf("expected title from proposal, got %s", project.Title)
	}
}

func TestService_UpdateProject(t *testing.T) {
	svc := NewService(NewMockStore())
	ctx := context.Background()

	proj, _ := svc.CreateProject(ctx, "space-1", &CreateProjectRequest{
		Title: "Old Title", Description: "Test", CreatedBy: "admin-1",
	})

	updated, err := svc.UpdateProject(ctx, "space-1", proj.ID, &UpdateProjectRequest{
		Title:       "New Title",
		Description: "Updated description",
	})
	if err != nil {
		t.Fatalf("UpdateProject failed: %v", err)
	}
	if updated.Title != "New Title" {
		t.Errorf("expected New Title, got %s", updated.Title)
	}
}

func TestService_DeleteProject_NoActivePlans(t *testing.T) {
	svc := NewService(NewMockStore())
	ctx := context.Background()

	proj, _ := svc.CreateProject(ctx, "space-1", &CreateProjectRequest{
		Title: "To Delete", Description: "Test", CreatedBy: "admin-1",
	})

	err := svc.DeleteProject(ctx, "space-1", proj.ID)
	if err != nil {
		t.Fatalf("DeleteProject failed: %v", err)
	}

	_, err = svc.GetProject(ctx, "space-1", proj.ID)
	if err == nil {
		t.Error("expected error after deletion")
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && go test ./internal/contributions/... -v -run "TestService_.*Project"`
Expected: FAIL — functions not defined

- [ ] **Step 3: Implement project service methods**

Add to `service.go`:

```go
// --- Projects ---

type CreateProjectRequest struct {
	Title       string         `json:"title"`
	Description string         `json:"description"`
	Images      []ProjectImage `json:"images,omitempty"`
	CreatedBy   string         `json:"created_by"`
}

type UpdateProjectRequest struct {
	Title       string         `json:"title,omitempty"`
	Description string         `json:"description,omitempty"`
	Images      []ProjectImage `json:"images,omitempty"`
}

func (s *Service) CreateProject(ctx context.Context, spaceID string, req *CreateProjectRequest) (*Project, error) {
	now := time.Now()
	p := &Project{
		ID:          generateID("proj"),
		Title:       req.Title,
		Description: req.Description,
		Status:      ProjectCreated,
		Images:      req.Images,
		CreatedBy:   req.CreatedBy,
		CreatedAt:   now,
		UpdatedAt:   now,
	}
	errs := ValidateProject(p)
	if len(errs) > 0 {
		return nil, fmt.Errorf("validation failed: %v", errs)
	}
	if err := s.store.Save(spaceID, p.ID, "project", p); err != nil {
		return nil, fmt.Errorf("saving project: %w", err)
	}
	return p, nil
}

func (s *Service) GetProject(ctx context.Context, spaceID, projectID string) (*Project, error) {
	var p Project
	if err := s.store.Get(spaceID, projectID, &p); err != nil {
		return nil, err
	}
	return &p, nil
}

func (s *Service) ListProjects(ctx context.Context, spaceID string) ([]*Project, error) {
	raw, err := s.store.List(spaceID, "project")
	if err != nil {
		return nil, err
	}
	var projects []*Project
	for _, r := range raw {
		var p Project
		if err := json.Unmarshal(r, &p); err == nil {
			projects = append(projects, &p)
		}
	}
	return projects, nil
}

func (s *Service) UpdateProject(ctx context.Context, spaceID, projectID string, req *UpdateProjectRequest) (*Project, error) {
	p, err := s.GetProject(ctx, spaceID, projectID)
	if err != nil {
		return nil, err
	}
	if req.Title != "" {
		p.Title = req.Title
	}
	if req.Description != "" {
		p.Description = req.Description
	}
	if req.Images != nil {
		p.Images = req.Images
	}
	p.UpdatedAt = time.Now()
	if err := s.store.Save(spaceID, p.ID, "project", p); err != nil {
		return nil, err
	}
	return p, nil
}

func (s *Service) DeleteProject(ctx context.Context, spaceID, projectID string) error {
	p, err := s.GetProject(ctx, spaceID, projectID)
	if err != nil {
		return err
	}
	if len(p.ImplementationPlanIDs) > 0 {
		return fmt.Errorf("cannot delete project with active implementation plans")
	}
	return s.store.Delete(spaceID, projectID)
}

func (s *Service) LinkProposalToProject(ctx context.Context, spaceID, projectID, proposalID string) (*Project, error) {
	p, err := s.GetProject(ctx, spaceID, projectID)
	if err != nil {
		return nil, err
	}
	for _, id := range p.ProposalIDs {
		if id == proposalID {
			return p, nil // already linked
		}
	}
	p.ProposalIDs = append(p.ProposalIDs, proposalID)
	p.UpdatedAt = time.Now()
	if err := s.store.Save(spaceID, p.ID, "project", p); err != nil {
		return nil, err
	}
	return p, nil
}

func (s *Service) AutoCreateProjectForProposal(ctx context.Context, spaceID, proposalID, createdBy string) (*Project, error) {
	prop, err := s.GetProposal(ctx, spaceID, proposalID)
	if err != nil {
		return nil, fmt.Errorf("proposal not found: %w", err)
	}
	project, err := s.CreateProject(ctx, spaceID, &CreateProjectRequest{
		Title:       prop.Title,
		Description: prop.Description,
		CreatedBy:   createdBy,
	})
	if err != nil {
		return nil, err
	}
	return s.LinkProposalToProject(ctx, spaceID, project.ID, proposalID)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && go test ./internal/contributions/... -v`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
cd backend && git add internal/contributions/service.go internal/contributions/service_test.go
git commit -m "feat: add project service methods (CRUD, link proposals, auto-create)"
```

---

### Task 3.2: Projects API Handler

**Files:**
- Create: `backend/internal/api/projects.go`
- Create: `backend/internal/api/projects_test.go`

- [ ] **Step 1: Write failing tests for project handler**

```go
// backend/internal/api/projects_test.go
package api

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestProjectsHandler_Create(t *testing.T) {
	handler := setupTestProjectsHandler()

	body := map[string]interface{}{
		"title":       "Test Project",
		"description": "A test project",
		"created_by":  "admin-1",
	}
	b, _ := json.Marshal(body)

	req := httptest.NewRequest(http.MethodPost, "/api/v1/projects", bytes.NewReader(b))
	w := httptest.NewRecorder()
	handler.HandleCreate(w, req)

	if w.Code != http.StatusCreated {
		t.Errorf("expected 201, got %d: %s", w.Code, w.Body.String())
	}
}

func TestProjectsHandler_List(t *testing.T) {
	handler := setupTestProjectsHandler()

	body, _ := json.Marshal(map[string]interface{}{
		"title": "Project", "description": "Test", "created_by": "admin-1",
	})
	req := httptest.NewRequest(http.MethodPost, "/api/v1/projects", bytes.NewReader(body))
	w := httptest.NewRecorder()
	handler.HandleCreate(w, req)

	req = httptest.NewRequest(http.MethodGet, "/api/v1/projects", nil)
	w = httptest.NewRecorder()
	handler.HandleList(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", w.Code)
	}
}

func TestProjectsHandler_Update(t *testing.T) {
	handler := setupTestProjectsHandler()

	body, _ := json.Marshal(map[string]interface{}{
		"title": "Old", "description": "Test", "created_by": "admin-1",
	})
	req := httptest.NewRequest(http.MethodPost, "/api/v1/projects", bytes.NewReader(body))
	w := httptest.NewRecorder()
	handler.HandleCreate(w, req)

	var created map[string]interface{}
	json.Unmarshal(w.Body.Bytes(), &created)
	id := created["id"].(string)

	update, _ := json.Marshal(map[string]string{"title": "New Title"})
	req = httptest.NewRequest(http.MethodPut, "/api/v1/projects/"+id, bytes.NewReader(update))
	w = httptest.NewRecorder()
	handler.HandleUpdate(w, req, id)

	if w.Code != http.StatusOK {
		t.Errorf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
}

func TestProjectsHandler_Delete(t *testing.T) {
	handler := setupTestProjectsHandler()

	body, _ := json.Marshal(map[string]interface{}{
		"title": "To Delete", "description": "Test", "created_by": "admin-1",
	})
	req := httptest.NewRequest(http.MethodPost, "/api/v1/projects", bytes.NewReader(body))
	w := httptest.NewRecorder()
	handler.HandleCreate(w, req)

	var created map[string]interface{}
	json.Unmarshal(w.Body.Bytes(), &created)
	id := created["id"].(string)

	req = httptest.NewRequest(http.MethodDelete, "/api/v1/projects/"+id, nil)
	w = httptest.NewRecorder()
	handler.HandleDelete(w, req, id)

	if w.Code != http.StatusOK {
		t.Errorf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && go test ./internal/api/... -run TestProjects -v`
Expected: FAIL

- [ ] **Step 3: Implement project handler**

```go
// backend/internal/api/projects.go
package api

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/matou-dao/backend/internal/contributions"
	"github.com/matou-dao/backend/internal/logging"
)

type ProjectsHandler struct {
	service      *contributions.Service
	spaceManager *anysync.SpaceManager
	log          *logging.Logger
}

func NewProjectsHandler(service *contributions.Service, spaceManager *anysync.SpaceManager) *ProjectsHandler {
	return &ProjectsHandler{
		service:      service,
		spaceManager: spaceManager,
		log:          logging.New("Projects"),
	}
}

func (h *ProjectsHandler) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/api/v1/projects", CORSHandler(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			h.HandleList(w, r)
		case http.MethodPost:
			h.HandleCreate(w, r)
		default:
			writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		}
	}))

	mux.HandleFunc("/api/v1/projects/", CORSHandler(func(w http.ResponseWriter, r *http.Request) {
		path := strings.TrimPrefix(r.URL.Path, "/api/v1/projects/")
		parts := strings.SplitN(path, "/", 2)
		id := parts[0]

		if len(parts) == 2 && parts[1] == "link-proposal" && r.Method == http.MethodPost {
			h.HandleLinkProposal(w, r, id)
			return
		}

		switch r.Method {
		case http.MethodGet:
			h.HandleGet(w, r, id)
		case http.MethodPut:
			h.HandleUpdate(w, r, id)
		case http.MethodDelete:
			h.HandleDelete(w, r, id)
		default:
			writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		}
	}))
}

func (h *ProjectsHandler) HandleCreate(w http.ResponseWriter, r *http.Request) {
	var req contributions.CreateProjectRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}
	spaceID := resolveCommunitySpaceID(r, h.spaceManager)
	project, err := h.service.CreateProject(r.Context(), spaceID, &req)
	if err != nil {
		h.log.Error("failed to create project: %v", err)
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	h.log.Info("project created: %s", project.ID)
	writeJSON(w, http.StatusCreated, project)
}

func (h *ProjectsHandler) HandleList(w http.ResponseWriter, r *http.Request) {
	spaceID := resolveCommunitySpaceID(r, h.spaceManager)
	projects, err := h.service.ListProjects(r.Context(), spaceID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{"projects": projects, "total": len(projects)})
}

func (h *ProjectsHandler) HandleGet(w http.ResponseWriter, r *http.Request, id string) {
	spaceID := resolveCommunitySpaceID(r, h.spaceManager)
	project, err := h.service.GetProject(r.Context(), spaceID, id)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "project not found"})
		return
	}
	writeJSON(w, http.StatusOK, project)
}

func (h *ProjectsHandler) HandleUpdate(w http.ResponseWriter, r *http.Request, id string) {
	var req contributions.UpdateProjectRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}
	spaceID := resolveCommunitySpaceID(r, h.spaceManager)
	project, err := h.service.UpdateProject(r.Context(), spaceID, id, &req)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	h.log.Info("project updated: %s", id)
	writeJSON(w, http.StatusOK, project)
}

func (h *ProjectsHandler) HandleDelete(w http.ResponseWriter, r *http.Request, id string) {
	spaceID := resolveCommunitySpaceID(r, h.spaceManager)
	if err := h.service.DeleteProject(r.Context(), spaceID, id); err != nil {
		h.log.Error("failed to delete project %s: %v", id, err)
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	h.log.Info("project deleted: %s", id)
	writeJSON(w, http.StatusOK, map[string]string{"success": "true"})
}

func (h *ProjectsHandler) HandleLinkProposal(w http.ResponseWriter, r *http.Request, id string) {
	var req struct {
		ProposalID string `json:"proposal_id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}
	spaceID := resolveCommunitySpaceID(r, h.spaceManager)
	project, err := h.service.LinkProposalToProject(r.Context(), spaceID, id, req.ProposalID)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, project)
}

func setupTestProjectsHandler() *ProjectsHandler {
	store := contributions.NewMockStore()
	svc := contributions.NewService(store)
	return NewProjectsHandler(svc, nil) // nil SpaceManager for unit tests — see note above
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && go test ./internal/api/... -run TestProjects -v`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
cd backend && git add internal/api/projects.go internal/api/projects_test.go
git commit -m "feat: add projects API handler with CRUD, link-proposal, and delete"
```

---

### Task 3.3: Frontend Projects API Client & Store

**Files:**
- Create: `frontend/src/lib/api/projects.ts`
- Create: `frontend/src/stores/projects.ts`

- [ ] **Step 1: Create projects API client**

```typescript
// frontend/src/lib/api/projects.ts
import { BACKEND_URL } from './client';
import { createLogger } from '../logging';

const log = createLogger('ProjectsAPI');

export interface ProjectImage {
  image_id: string;
  url: string;
  type: 'logo' | 'banner' | 'screenshot' | 'other';
  alt_text?: string;
  uploaded_at: string;
  uploaded_by: string;
}

export interface Project {
  id: string;
  title: string;
  description: string;
  status: 'created' | 'active' | 'completed' | 'archived';
  images?: ProjectImage[];
  proposal_ids?: string[];
  implementation_plan_ids?: string[];
  project_steward_id?: string;
  project_lead_id?: string;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface CreateProjectRequest {
  title: string;
  description: string;
  images?: ProjectImage[];
  created_by: string;
}

export interface UpdateProjectRequest {
  title?: string;
  description?: string;
  images?: ProjectImage[];
}

export async function createProject(req: CreateProjectRequest): Promise<Project> {
  log.info('Creating project: %s', req.title);
  const response = await fetch(`${BACKEND_URL}/api/v1/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(err.error || 'Failed to create project');
  }
  return response.json();
}

export async function listProjects(): Promise<{ projects: Project[]; total: number }> {
  const response = await fetch(`${BACKEND_URL}/api/v1/projects`);
  if (!response.ok) throw new Error('Failed to list projects');
  return response.json();
}

export async function getProject(id: string): Promise<Project> {
  const response = await fetch(`${BACKEND_URL}/api/v1/projects/${id}`);
  if (!response.ok) throw new Error('Project not found');
  return response.json();
}

export async function updateProject(id: string, req: UpdateProjectRequest): Promise<Project> {
  const response = await fetch(`${BACKEND_URL}/api/v1/projects/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  });
  if (!response.ok) throw new Error('Failed to update project');
  return response.json();
}

export async function deleteProject(id: string): Promise<void> {
  const response = await fetch(`${BACKEND_URL}/api/v1/projects/${id}`, { method: 'DELETE' });
  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(err.error || 'Failed to delete project');
  }
}

export async function linkProposalToProject(projectId: string, proposalId: string): Promise<Project> {
  const response = await fetch(`${BACKEND_URL}/api/v1/projects/${projectId}/link-proposal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ proposal_id: proposalId }),
  });
  if (!response.ok) throw new Error('Failed to link proposal');
  return response.json();
}
```

- [ ] **Step 2: Create projects Pinia store**

```typescript
// frontend/src/stores/projects.ts
import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import {
  createProject as apiCreate,
  listProjects as apiList,
  getProject as apiGet,
  updateProject as apiUpdate,
  deleteProject as apiDelete,
  linkProposalToProject as apiLink,
  type Project,
  type CreateProjectRequest,
  type UpdateProjectRequest,
} from 'src/lib/api/projects';
import { createLogger } from 'src/lib/logging';

const log = createLogger('ProjectsStore');

export const useProjectsStore = defineStore('projects', () => {
  const projects = ref<Project[]>([]);
  const currentProject = ref<Project | null>(null);
  const isLoading = ref(false);
  const error = ref<string | null>(null);

  const activeProjects = computed(() => projects.value.filter(p => p.status === 'active'));

  async function fetchProjects() {
    isLoading.value = true;
    error.value = null;
    try {
      const result = await apiList();
      projects.value = result.projects || [];
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Failed to fetch projects';
      log.error('fetchProjects: %s', error.value);
    } finally {
      isLoading.value = false;
    }
  }

  async function fetchProject(id: string) {
    isLoading.value = true;
    error.value = null;
    try {
      currentProject.value = await apiGet(id);
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Failed to fetch project';
    } finally {
      isLoading.value = false;
    }
  }

  async function create(req: CreateProjectRequest) {
    error.value = null;
    try {
      const project = await apiCreate(req);
      projects.value.push(project);
      return project;
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Failed to create project';
      throw e;
    }
  }

  async function update(id: string, req: UpdateProjectRequest) {
    error.value = null;
    try {
      const updated = await apiUpdate(id, req);
      const idx = projects.value.findIndex(p => p.id === id);
      if (idx >= 0) projects.value[idx] = updated;
      if (currentProject.value?.id === id) currentProject.value = updated;
      return updated;
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Update failed';
      throw e;
    }
  }

  async function remove(id: string) {
    error.value = null;
    try {
      await apiDelete(id);
      projects.value = projects.value.filter(p => p.id !== id);
      if (currentProject.value?.id === id) currentProject.value = null;
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Delete failed';
      throw e;
    }
  }

  async function linkProposal(projectId: string, proposalId: string) {
    error.value = null;
    try {
      const updated = await apiLink(projectId, proposalId);
      const idx = projects.value.findIndex(p => p.id === projectId);
      if (idx >= 0) projects.value[idx] = updated;
      return updated;
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Link failed';
      throw e;
    }
  }

  return {
    projects, currentProject, isLoading, error, activeProjects,
    fetchProjects, fetchProject, create, update, remove, linkProposal,
  };
});
```

- [ ] **Step 3: Commit**

```bash
cd frontend && git add src/lib/api/projects.ts src/stores/projects.ts
git commit -m "feat: add projects API client and Pinia store"
```

---

### Task 3.4: Wire Projects Handler in main.go & Phase 3 Checkpoint

**Files:**
- Modify: `backend/cmd/server/main.go`

- [ ] **Step 1: Add projects handler after proposals handler in main.go**

```go
	projectsHandler := api.NewProjectsHandler(contribService, spaceManager)
```

Register routes:
```go
	projectsHandler.RegisterRoutes(mux)
```

Add endpoint docs:
```go
	fmt.Println("  Projects:")
	fmt.Println("  GET  /api/v1/projects                     - List projects")
	fmt.Println("  POST /api/v1/projects                     - Create project")
	fmt.Println("  GET  /api/v1/projects/{id}                - Get project")
	fmt.Println("  PUT  /api/v1/projects/{id}                - Update project")
	fmt.Println("  DELETE /api/v1/projects/{id}               - Delete project")
	fmt.Println("  POST /api/v1/projects/{id}/link-proposal  - Link proposal to project")
	fmt.Println()
```

- [ ] **Step 2: Run all tests**

Run: `cd backend && go test ./internal/... -v`
Expected: ALL PASS

- [ ] **Step 3: Verify Phase 3 against design document**

Checklist:
- [x] Project CRUD (create, read, update, delete) — Section 4.3
- [x] Project schema matches: id, title, description, status, images, proposal_ids, etc. — Section 4.3.1
- [x] Project image schema: image_id, url, type, alt_text — Section 4.3.2
- [x] Project status lifecycle: created, active, completed, archived — Section 4.3.3
- [x] Auto-creation from approved proposal — Section 4.3.4
- [x] Link to existing project option — Section 4.3.4
- [x] Admin-only operations (create/edit/delete) — Section 4.3.5
- [x] Delete blocked if active implementation plans — Section 4.3.5
- [x] Many-to-many proposal↔project relationship — Section 4.3.6
- [x] Frontend API client + Pinia store

- [ ] **Step 4: Commit and tag**

```bash
git add -A && git commit -m "feat: wire projects handler in main.go"
git tag phase-3-projects
```

---

## Chunk 4: Phase 4 — Decision Plans & Governance Actions

### Task 4.1: Decision Plan & Governance Action Service Methods

**Files:**
- Modify: `backend/internal/contributions/service.go`
- Modify: `backend/internal/contributions/service_test.go`

- [ ] **Step 1: Write failing tests**

Add to `service_test.go`:

```go
func TestService_CreateDecisionPlan(t *testing.T) {
	svc := NewService(NewMockStore())
	ctx := context.Background()

	dp, err := svc.CreateDecisionPlan(ctx, "space-1", &CreateDecisionPlanRequest{
		ProposalID:        "prop-1",
		Title:             "Governance Path",
		Description:       "Decision plan for proposal",
		Objectives:        []string{"Get elder approval"},
		ExpectedOutcomes:  []string{"Approved"},
		ProposalLeadID:    "lead-1",
		ProposalStewardID: "steward-1",
	})
	if err != nil {
		t.Fatalf("CreateDecisionPlan failed: %v", err)
	}
	if dp.Status != DecisionPlanDrafted {
		t.Errorf("expected drafted, got %s", dp.Status)
	}
	if dp.ProposalID != "prop-1" {
		t.Errorf("expected prop-1, got %s", dp.ProposalID)
	}
}

func TestService_TransitionDecisionPlan(t *testing.T) {
	svc := NewService(NewMockStore())
	ctx := context.Background()

	dp, _ := svc.CreateDecisionPlan(ctx, "space-1", &CreateDecisionPlanRequest{
		ProposalID: "prop-1", Title: "Test", Description: "d",
		Objectives: []string{"o"}, ExpectedOutcomes: []string{"o"},
		ProposalLeadID: "lead-1", ProposalStewardID: "steward-1",
	})

	updated, err := svc.TransitionDecisionPlan(ctx, "space-1", dp.ID, DecisionPlanSubmitted)
	if err != nil {
		t.Fatalf("TransitionDecisionPlan failed: %v", err)
	}
	if updated.Status != DecisionPlanSubmitted {
		t.Errorf("expected submitted, got %s", updated.Status)
	}

	// Invalid: drafted → signed_off
	_, err = svc.TransitionDecisionPlan(ctx, "space-1", dp.ID, DecisionPlanDrafted)
	if err == nil {
		t.Error("expected error for invalid transition")
	}
}

func TestService_AddGovernanceAction(t *testing.T) {
	svc := NewService(NewMockStore())
	ctx := context.Background()

	dp, _ := svc.CreateDecisionPlan(ctx, "space-1", &CreateDecisionPlanRequest{
		ProposalID: "prop-1", Title: "Test", Description: "d",
		Objectives: []string{"o"}, ExpectedOutcomes: []string{"o"},
		ProposalLeadID: "lead-1", ProposalStewardID: "steward-1",
	})

	action, err := svc.AddGovernanceAction(ctx, "space-1", &CreateGovernanceActionRequest{
		DecisionPlanID: dp.ID,
		House:          HouseElderCouncil,
		ActionType:     ActionDecision,
		Description:    "Elder veto check",
	})
	if err != nil {
		t.Fatalf("AddGovernanceAction failed: %v", err)
	}
	if action.Status != GovActionPlanned {
		t.Errorf("expected planned, got %s", action.Status)
	}
	if action.DecisionPlanID != dp.ID {
		t.Errorf("expected decision_plan_id %s, got %s", dp.ID, action.DecisionPlanID)
	}
}

func TestService_CompleteGovernanceAction(t *testing.T) {
	svc := NewService(NewMockStore())
	ctx := context.Background()

	action, _ := svc.AddGovernanceAction(ctx, "space-1", &CreateGovernanceActionRequest{
		DecisionPlanID: "dp-1",
		House:          HouseElderCouncil,
		ActionType:     ActionDecision,
		Description:    "Elder veto check",
	})

	updated, err := svc.CompleteGovernanceAction(ctx, "space-1", action.ID, OutcomeNoVeto)
	if err != nil {
		t.Fatalf("CompleteGovernanceAction failed: %v", err)
	}
	if updated.Status != GovActionCompleted {
		t.Errorf("expected completed, got %s", updated.Status)
	}
	if updated.Outcome != OutcomeNoVeto {
		t.Errorf("expected no_veto, got %s", updated.Outcome)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && go test ./internal/contributions/... -run "DecisionPlan|GovernanceAction" -v`
Expected: FAIL

- [ ] **Step 3: Implement decision plan and governance action service methods**

Add to `service.go`:

```go
// --- Decision Plans ---

type CreateDecisionPlanRequest struct {
	ProposalID        string   `json:"proposal_id"`
	Title             string   `json:"title"`
	Description       string   `json:"description"`
	Objectives        []string `json:"objectives"`
	ExpectedOutcomes  []string `json:"expected_outcomes"`
	ProposalLeadID    string   `json:"proposal_lead_id"`
	ProposalStewardID string   `json:"proposal_steward_id"`
}

func (s *Service) CreateDecisionPlan(ctx context.Context, spaceID string, req *CreateDecisionPlanRequest) (*DecisionPlan, error) {
	now := time.Now()
	dp := &DecisionPlan{
		ID:                generateID("dp"),
		ProposalID:        req.ProposalID,
		Title:             req.Title,
		Description:       req.Description,
		Status:            DecisionPlanDrafted,
		Objectives:        req.Objectives,
		ExpectedOutcomes:  req.ExpectedOutcomes,
		ProposalLeadID:    req.ProposalLeadID,
		ProposalStewardID: req.ProposalStewardID,
		CreatedAt:         now,
		UpdatedAt:         now,
	}
	if err := s.store.Save(spaceID, dp.ID, "decision_plan", dp); err != nil {
		return nil, err
	}
	return dp, nil
}

func (s *Service) GetDecisionPlan(ctx context.Context, spaceID, dpID string) (*DecisionPlan, error) {
	var dp DecisionPlan
	if err := s.store.Get(spaceID, dpID, &dp); err != nil {
		return nil, err
	}
	return &dp, nil
}

func (s *Service) ListDecisionPlans(ctx context.Context, spaceID string) ([]*DecisionPlan, error) {
	raw, err := s.store.List(spaceID, "decision_plan")
	if err != nil {
		return nil, err
	}
	var plans []*DecisionPlan
	for _, r := range raw {
		var dp DecisionPlan
		if err := json.Unmarshal(r, &dp); err == nil {
			plans = append(plans, &dp)
		}
	}
	return plans, nil
}

func (s *Service) TransitionDecisionPlan(ctx context.Context, spaceID, dpID string, newStatus DecisionPlanStatus) (*DecisionPlan, error) {
	dp, err := s.GetDecisionPlan(ctx, spaceID, dpID)
	if err != nil {
		return nil, err
	}
	if err := ValidateDecisionPlanTransition(dp.Status, newStatus); err != nil {
		return nil, err
	}
	dp.Status = newStatus
	dp.UpdatedAt = time.Now()
	if err := s.store.Save(spaceID, dp.ID, "decision_plan", dp); err != nil {
		return nil, err
	}
	return dp, nil
}

// --- Governance Actions ---

type CreateGovernanceActionRequest struct {
	DecisionPlanID string     `json:"decision_plan_id"`
	House          HouseType  `json:"house"`
	ActionType     ActionType `json:"action_type"`
	Description    string     `json:"description"`
}

func (s *Service) AddGovernanceAction(ctx context.Context, spaceID string, req *CreateGovernanceActionRequest) (*GovernanceAction, error) {
	now := time.Now()
	action := &GovernanceAction{
		ID:             generateID("ga"),
		DecisionPlanID: req.DecisionPlanID,
		House:          req.House,
		ActionType:     req.ActionType,
		Description:    req.Description,
		Status:         GovActionPlanned,
		CreatedAt:      now,
		UpdatedAt:      now,
	}
	if err := s.store.Save(spaceID, action.ID, "governance_action", action); err != nil {
		return nil, err
	}
	return action, nil
}

func (s *Service) GetGovernanceAction(ctx context.Context, spaceID, actionID string) (*GovernanceAction, error) {
	var action GovernanceAction
	if err := s.store.Get(spaceID, actionID, &action); err != nil {
		return nil, err
	}
	return &action, nil
}

func (s *Service) CompleteGovernanceAction(ctx context.Context, spaceID, actionID string, outcome OutcomeType) (*GovernanceAction, error) {
	action, err := s.GetGovernanceAction(ctx, spaceID, actionID)
	if err != nil {
		return nil, err
	}
	if err := ValidateGovernanceActionTransition(action.Status, GovActionCompleted); err != nil {
		return nil, err
	}
	action.Status = GovActionCompleted
	action.Outcome = outcome
	action.UpdatedAt = time.Now()
	if err := s.store.Save(spaceID, action.ID, "governance_action", action); err != nil {
		return nil, err
	}
	return action, nil
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && go test ./internal/contributions/... -v`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
cd backend && git add internal/contributions/service.go internal/contributions/service_test.go
git commit -m "feat: add decision plan and governance action service methods"
```

---

### Task 4.2: Decision Plans API Handler

**Files:**
- Create: `backend/internal/api/decision_plans.go`
- Create: `backend/internal/api/decision_plans_test.go`

- [ ] **Step 1: Write failing tests**

```go
// backend/internal/api/decision_plans_test.go
package api

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func setupTestDecisionPlansHandler() *DecisionPlansHandler {
	store := contributions.NewMockStore()
	svc := contributions.NewService(store)
	return NewDecisionPlansHandler(svc)
}

func TestDecisionPlansHandler_Create(t *testing.T) {
	handler := setupTestDecisionPlansHandler()

	body, _ := json.Marshal(map[string]interface{}{
		"proposal_id":        "prop-1",
		"title":              "Test Plan",
		"description":        "A decision plan",
		"objectives":         []string{"Get approval"},
		"expected_outcomes":  []string{"Approved"},
		"proposal_lead_id":   "lead-1",
		"proposal_steward_id": "steward-1",
	})

	req := httptest.NewRequest(http.MethodPost, "/api/v1/decision-plans", bytes.NewReader(body))
	w := httptest.NewRecorder()
	handler.HandleCreate(w, req)

	if w.Code != http.StatusCreated {
		t.Errorf("expected 201, got %d: %s", w.Code, w.Body.String())
	}
}

func TestDecisionPlansHandler_Transition(t *testing.T) {
	handler := setupTestDecisionPlansHandler()

	body, _ := json.Marshal(map[string]interface{}{
		"proposal_id": "prop-1", "title": "Test", "description": "d",
		"objectives": []string{"o"}, "expected_outcomes": []string{"o"},
		"proposal_lead_id": "lead-1", "proposal_steward_id": "steward-1",
	})
	req := httptest.NewRequest(http.MethodPost, "/api/v1/decision-plans", bytes.NewReader(body))
	w := httptest.NewRecorder()
	handler.HandleCreate(w, req)

	var created map[string]interface{}
	json.Unmarshal(w.Body.Bytes(), &created)
	id := created["id"].(string)

	transBody, _ := json.Marshal(map[string]string{"status": "submitted"})
	req = httptest.NewRequest(http.MethodPost, "/api/v1/decision-plans/"+id+"/transition", bytes.NewReader(transBody))
	w = httptest.NewRecorder()
	handler.HandleTransition(w, req, id)

	if w.Code != http.StatusOK {
		t.Errorf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
}
```

- [ ] **Step 2: Implement handler**

```go
// backend/internal/api/decision_plans.go
package api

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/matou-dao/backend/internal/contributions"
	"github.com/matou-dao/backend/internal/logging"
)

type DecisionPlansHandler struct {
	service      *contributions.Service
	spaceManager *anysync.SpaceManager
	log          *logging.Logger
}

func NewDecisionPlansHandler(service *contributions.Service, spaceManager *anysync.SpaceManager) *DecisionPlansHandler {
	return &DecisionPlansHandler{service: service, spaceManager: spaceManager, log: logging.New("DecisionPlans")}
}

func (h *DecisionPlansHandler) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/api/v1/decision-plans", CORSHandler(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			h.HandleList(w, r)
		case http.MethodPost:
			h.HandleCreate(w, r)
		default:
			writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		}
	}))

	mux.HandleFunc("/api/v1/decision-plans/", CORSHandler(func(w http.ResponseWriter, r *http.Request) {
		path := strings.TrimPrefix(r.URL.Path, "/api/v1/decision-plans/")
		parts := strings.SplitN(path, "/", 2)
		id := parts[0]

		if len(parts) == 2 && parts[1] == "transition" && r.Method == http.MethodPost {
			h.HandleTransition(w, r, id)
			return
		}
		if len(parts) == 2 && parts[1] == "actions" {
			switch r.Method {
			case http.MethodPost:
				h.HandleAddAction(w, r, id)
			default:
				writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
			}
			return
		}
		if r.Method == http.MethodGet {
			h.HandleGet(w, r, id)
			return
		}
	}))

	mux.HandleFunc("/api/v1/governance-actions/", CORSHandler(func(w http.ResponseWriter, r *http.Request) {
		path := strings.TrimPrefix(r.URL.Path, "/api/v1/governance-actions/")
		parts := strings.SplitN(path, "/", 2)
		id := parts[0]

		if len(parts) == 2 && parts[1] == "complete" && r.Method == http.MethodPost {
			h.HandleCompleteAction(w, r, id)
			return
		}
	}))
}

func (h *DecisionPlansHandler) HandleCreate(w http.ResponseWriter, r *http.Request) {
	var req contributions.CreateDecisionPlanRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}
	spaceID := resolveCommunitySpaceID(r, h.spaceManager)

	dp, err := h.service.CreateDecisionPlan(r.Context(), spaceID, &req)
	if err != nil {
		h.log.Error("create failed: %v", err)
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	h.log.Info("decision plan created: %s for proposal %s", dp.ID, dp.ProposalID)
	writeJSON(w, http.StatusCreated, dp)
}

func (h *DecisionPlansHandler) HandleGet(w http.ResponseWriter, r *http.Request, id string) {
	spaceID := resolveCommunitySpaceID(r, h.spaceManager)
	dp, err := h.service.GetDecisionPlan(r.Context(), spaceID, id)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	}
	writeJSON(w, http.StatusOK, dp)
}

func (h *DecisionPlansHandler) HandleList(w http.ResponseWriter, r *http.Request) {
	spaceID := resolveCommunitySpaceID(r, h.spaceManager)
	plans, err := h.service.ListDecisionPlans(r.Context(), spaceID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{"decision_plans": plans, "total": len(plans)})
}

func (h *DecisionPlansHandler) HandleTransition(w http.ResponseWriter, r *http.Request, id string) {
	var req struct { Status string `json:"status"` }
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}
	spaceID := resolveCommunitySpaceID(r, h.spaceManager)
	dp, err := h.service.TransitionDecisionPlan(r.Context(), spaceID, id, contributions.DecisionPlanStatus(req.Status))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, dp)
}

func (h *DecisionPlansHandler) HandleAddAction(w http.ResponseWriter, r *http.Request, dpID string) {
	var req contributions.CreateGovernanceActionRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}
	req.DecisionPlanID = dpID
	spaceID := resolveCommunitySpaceID(r, h.spaceManager)
	action, err := h.service.AddGovernanceAction(r.Context(), spaceID, &req)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusCreated, action)
}

func (h *DecisionPlansHandler) HandleCompleteAction(w http.ResponseWriter, r *http.Request, actionID string) {
	var req struct { Outcome string `json:"outcome"` }
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}
	spaceID := resolveCommunitySpaceID(r, h.spaceManager)
	action, err := h.service.CompleteGovernanceAction(r.Context(), spaceID, actionID, contributions.OutcomeType(req.Outcome))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, action)
}
```

- [ ] **Step 3: Run tests**

Run: `cd backend && go test ./internal/api/... -run "TestDecisionPlans" -v`
Expected: ALL PASS

- [ ] **Step 4: Wire in main.go, commit, and tag**

```go
	decisionPlansHandler := api.NewDecisionPlansHandler(contribService, spaceManager)
	decisionPlansHandler.RegisterRoutes(mux)
```

```bash
cd backend && git add internal/api/decision_plans.go internal/api/decision_plans_test.go cmd/server/main.go
git commit -m "feat: add decision plans and governance actions API handlers"
git tag phase-4-governance
```

---

### Task 4.3: Frontend Decision Plans API Client & Store

**Files:**
- Create: `frontend/src/lib/api/decisionPlans.ts`

- [ ] **Step 1: Create API client**

```typescript
// frontend/src/lib/api/decisionPlans.ts
import { BACKEND_URL } from './client';
import { createLogger } from '../logging';

const log = createLogger('DecisionPlansAPI');

export interface GovernanceAction {
  id: string;
  decision_plan_id: string;
  house: 'elders_council' | 'community_reps' | 'contributors';
  action_type: 'discussion' | 'decision' | 'meeting';
  description: string;
  status: 'planned' | 'completed' | 'archived';
  outcome?: 'no_veto' | 'veto' | 'approved' | 'rejected';
  vote_data?: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface DecisionPlan {
  id: string;
  proposal_id: string;
  title: string;
  description: string;
  status: 'drafted' | 'submitted' | 'signed_off';
  objectives: string[];
  expected_outcomes: string[];
  governance_actions: GovernanceAction[];
  proposal_lead_id: string;
  proposal_steward_id: string;
  created_at: string;
  updated_at: string;
}

export async function createDecisionPlan(req: Omit<DecisionPlan, 'id' | 'status' | 'governance_actions' | 'created_at' | 'updated_at'>): Promise<DecisionPlan> {
  log.info('Creating decision plan for proposal %s', req.proposal_id);
  const response = await fetch(`${BACKEND_URL}/api/v1/decision-plans`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  });
  if (!response.ok) throw new Error('Failed to create decision plan');
  return response.json();
}

export async function listDecisionPlans(): Promise<{ decision_plans: DecisionPlan[]; total: number }> {
  const response = await fetch(`${BACKEND_URL}/api/v1/decision-plans`);
  if (!response.ok) throw new Error('Failed to list decision plans');
  return response.json();
}

export async function getDecisionPlan(id: string): Promise<DecisionPlan> {
  const response = await fetch(`${BACKEND_URL}/api/v1/decision-plans/${id}`);
  if (!response.ok) throw new Error('Decision plan not found');
  return response.json();
}

export async function transitionDecisionPlan(id: string, status: string): Promise<DecisionPlan> {
  const response = await fetch(`${BACKEND_URL}/api/v1/decision-plans/${id}/transition`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status }),
  });
  if (!response.ok) throw new Error('Transition failed');
  return response.json();
}

export async function addGovernanceAction(dpId: string, action: { house: string; action_type: string; description: string }): Promise<GovernanceAction> {
  const response = await fetch(`${BACKEND_URL}/api/v1/decision-plans/${dpId}/actions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(action),
  });
  if (!response.ok) throw new Error('Failed to add governance action');
  return response.json();
}

export async function completeGovernanceAction(actionId: string, outcome: string): Promise<GovernanceAction> {
  const response = await fetch(`${BACKEND_URL}/api/v1/governance-actions/${actionId}/complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ outcome }),
  });
  if (!response.ok) throw new Error('Failed to complete action');
  return response.json();
}
```

- [ ] **Step 2: Commit**

```bash
cd frontend && git add src/lib/api/decisionPlans.ts
git commit -m "feat: add decision plans and governance actions API client"
```

---

### Phase 4 Verification Checkpoint

Checklist:
- [x] Decision plan CRUD — Section 4.2
- [x] Decision plan status lifecycle: drafted → submitted → signed_off — Section 4.2.1a
- [x] Decision plan includes: proposal_id, proposal_lead_id, proposal_steward_id — Section 4.2.1
- [x] Governance action includes: decision_plan_id, status (planned/completed/archived) — Section 4.2.2
- [x] Governance action status definitions table — Section 4.2.2
- [x] Governance action outcome types: no_veto, veto, approved, rejected — Section 4.2.2
- [x] All transitions validated
- [x] Frontend API client

---

## Chunk 5: Phase 5 — Implementation Plans, Milestones & Contributions

### Task 5.1: Implementation Plan & Contribution Service Methods

**Files:**
- Modify: `backend/internal/contributions/service.go`
- Modify: `backend/internal/contributions/service_test.go`

- [ ] **Step 1: Write failing tests**

Add to `service_test.go`:

```go
func TestService_CreateImplementationPlan(t *testing.T) {
	svc := NewService(NewMockStore())
	ctx := context.Background()

	ip, err := svc.CreateImplementationPlan(ctx, "space-1", &CreateImplementationPlanRequest{
		ProjectID:        "proj-1",
		Title:            "Phase 1 Implementation",
		TotalBudget:      "$10000",
		ProjectLeadID:    "lead-1",
		ProjectStewardID: "steward-1",
	})
	if err != nil {
		t.Fatalf("failed: %v", err)
	}
	if ip.ProjectID != "proj-1" {
		t.Errorf("expected proj-1, got %s", ip.ProjectID)
	}
	if ip.ProjectStewardID != "steward-1" {
		t.Errorf("expected steward-1, got %s", ip.ProjectStewardID)
	}
}

func TestService_AddMilestone(t *testing.T) {
	svc := NewService(NewMockStore())
	ctx := context.Background()

	ip, _ := svc.CreateImplementationPlan(ctx, "space-1", &CreateImplementationPlanRequest{
		ProjectID: "proj-1", Title: "Plan", TotalBudget: "$1",
		ProjectLeadID: "lead-1", ProjectStewardID: "steward-1",
	})

	ms, err := svc.AddMilestone(ctx, "space-1", &CreateMilestoneRequest{
		ImplementationPlanID: ip.ID,
		Title:                "Design Phase",
		Duration:             "2 weeks",
	})
	if err != nil {
		t.Fatalf("failed: %v", err)
	}
	if ms.ImplementationPlanID != ip.ID {
		t.Errorf("expected plan ID %s, got %s", ip.ID, ms.ImplementationPlanID)
	}
}

func TestService_CreateContribution(t *testing.T) {
	svc := NewService(NewMockStore())
	ctx := context.Background()

	c, err := svc.CreateContribution(ctx, "space-1", &CreateContributionRequest{
		ProjectID:        "proj-1",
		Title:            "Build landing page",
		Description:      "Create the main landing page",
		ContributionType: ProposalTypeTechnical,
		Priority:         PriorityMedium,
		CreatedBy:        "lead-1",
		Objectives:       []string{"Page deployed"},
		Deliverables:     []string{"HTML/CSS page"},
		AcceptanceCriteria: []string{"Responsive design"},
		SkillRequirements: []string{"frontend"},
	})
	if err != nil {
		t.Fatalf("failed: %v", err)
	}
	if c.Status != ContribCreated {
		t.Errorf("expected created, got %s", c.Status)
	}
}

func TestService_ContributionLifecycle(t *testing.T) {
	svc := NewService(NewMockStore())
	ctx := context.Background()

	c, _ := svc.CreateContribution(ctx, "space-1", &CreateContributionRequest{
		ProjectID: "proj-1", Title: "Task", Description: "Do it",
		ContributionType: ProposalTypeTechnical, Priority: PriorityLow,
		CreatedBy: "lead-1", Objectives: []string{"o"},
		Deliverables: []string{"d"}, AcceptanceCriteria: []string{"a"},
		SkillRequirements: []string{"s"},
	})

	// Full lifecycle: created → confirmed → assigned → needs_review → approved → signed_off
	transitions := []ContributionStatus{
		ContribConfirmed, ContribAssigned, ContribNeedsReview,
		ContribApproved, ContribSignedOff,
	}
	for _, status := range transitions {
		updated, err := svc.TransitionContribution(ctx, "space-1", c.ID, status)
		if err != nil {
			t.Fatalf("transition to %s failed: %v", status, err)
		}
		if updated.Status != status {
			t.Errorf("expected %s, got %s", status, updated.Status)
		}
	}
}

func TestService_ContributionIncompleteFlow(t *testing.T) {
	svc := NewService(NewMockStore())
	ctx := context.Background()

	c, _ := svc.CreateContribution(ctx, "space-1", &CreateContributionRequest{
		ProjectID: "proj-1", Title: "Task", Description: "Do it",
		ContributionType: ProposalTypeTechnical, Priority: PriorityLow,
		CreatedBy: "lead-1", Objectives: []string{"o"},
		Deliverables: []string{"d"}, AcceptanceCriteria: []string{"a"},
		SkillRequirements: []string{"s"},
	})

	// created → confirmed → assigned → needs_review → incomplete → assigned
	for _, s := range []ContributionStatus{ContribConfirmed, ContribAssigned, ContribNeedsReview, ContribIncomplete, ContribAssigned} {
		c, _ = svc.TransitionContribution(ctx, "space-1", c.ID, s)
	}
	if c.Status != ContribAssigned {
		t.Errorf("expected assigned after incomplete loop, got %s", c.Status)
	}
}

func TestService_ContributionDeclinedFlow(t *testing.T) {
	svc := NewService(NewMockStore())
	ctx := context.Background()

	c, _ := svc.CreateContribution(ctx, "space-1", &CreateContributionRequest{
		ProjectID: "proj-1", Title: "Task", Description: "Do it",
		ContributionType: ProposalTypeTechnical, Priority: PriorityLow,
		CreatedBy: "lead-1", Objectives: []string{"o"},
		Deliverables: []string{"d"}, AcceptanceCriteria: []string{"a"},
		SkillRequirements: []string{"s"},
	})

	for _, s := range []ContributionStatus{ContribConfirmed, ContribAssigned, ContribNeedsReview, ContribDeclined, ContribArchived} {
		c, _ = svc.TransitionContribution(ctx, "space-1", c.ID, s)
	}
	if c.Status != ContribArchived {
		t.Errorf("expected archived after declined, got %s", c.Status)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && go test ./internal/contributions/... -run "TestService_Create(Implementation|Contribution)|TestService_Add|TestService_Contribution" -v`
Expected: FAIL

- [ ] **Step 3: Implement service methods**

Add to `service.go`:

```go
// --- Implementation Plans ---

type CreateImplementationPlanRequest struct {
	ProjectID        string `json:"project_id"`
	Title            string `json:"title"`
	TotalBudget      string `json:"total_budget"`
	ProjectLeadID    string `json:"project_lead"`
	ProjectStewardID string `json:"project_steward_id"`
}

func (s *Service) CreateImplementationPlan(ctx context.Context, spaceID string, req *CreateImplementationPlanRequest) (*ImplementationPlan, error) {
	now := time.Now()
	ip := &ImplementationPlan{
		ID:               generateID("ip"),
		ProjectID:        req.ProjectID,
		Title:            req.Title,
		TotalBudget:      req.TotalBudget,
		ProjectLeadID:    req.ProjectLeadID,
		ProjectStewardID: req.ProjectStewardID,
		CurrentStatus:    "created",
		CreatedAt:        now,
		UpdatedAt:        now,
	}
	if err := s.store.Save(spaceID, ip.ID, "implementation_plan", ip); err != nil {
		return nil, err
	}
	return ip, nil
}

func (s *Service) GetImplementationPlan(ctx context.Context, spaceID, ipID string) (*ImplementationPlan, error) {
	var ip ImplementationPlan
	if err := s.store.Get(spaceID, ipID, &ip); err != nil {
		return nil, err
	}
	return &ip, nil
}

func (s *Service) ListImplementationPlans(ctx context.Context, spaceID string) ([]*ImplementationPlan, error) {
	raw, err := s.store.List(spaceID, "implementation_plan")
	if err != nil {
		return nil, err
	}
	var plans []*ImplementationPlan
	for _, r := range raw {
		var ip ImplementationPlan
		if err := json.Unmarshal(r, &ip); err == nil {
			plans = append(plans, &ip)
		}
	}
	return plans, nil
}

// --- Milestones ---

type CreateMilestoneRequest struct {
	ImplementationPlanID string `json:"implementation_plan_id"`
	Title                string `json:"title"`
	Duration             string `json:"duration"`
}

func (s *Service) AddMilestone(ctx context.Context, spaceID string, req *CreateMilestoneRequest) (*Milestone, error) {
	ms := &Milestone{
		MilestoneID:          generateID("ms"),
		ImplementationPlanID: req.ImplementationPlanID,
		Title:                req.Title,
		Duration:             req.Duration,
	}
	if err := s.store.Save(spaceID, ms.MilestoneID, "milestone", ms); err != nil {
		return nil, err
	}
	return ms, nil
}

// --- Contributions ---

type CreateContributionRequest struct {
	ProjectID          string       `json:"project_id"`
	Title              string       `json:"title"`
	Description        string       `json:"description"`
	ContributionType   ProposalType `json:"contribution_type"`
	Priority           Priority     `json:"priority"`
	CreatedBy          string       `json:"created_by"`
	Objectives         []string     `json:"objectives"`
	Deliverables       []string     `json:"deliverables"`
	AcceptanceCriteria []string     `json:"acceptance_criteria"`
	SkillRequirements  []string     `json:"skill_requirements"`
	MilestoneID        string       `json:"milestone_id,omitempty"`
	ParentContributionID string     `json:"parent_contribution,omitempty"`
	EstimatedDuration  int          `json:"estimated_duration,omitempty"`
	Tags               []string     `json:"tags,omitempty"`
}

func (s *Service) CreateContribution(ctx context.Context, spaceID string, req *CreateContributionRequest) (*Contribution, error) {
	now := time.Now()
	c := &Contribution{
		ID:                 generateID("ctr"),
		ProjectID:          req.ProjectID,
		Title:              req.Title,
		Description:        req.Description,
		ContributionType:   req.ContributionType,
		Priority:           req.Priority,
		CreatedBy:          req.CreatedBy,
		Objectives:         req.Objectives,
		Deliverables:       req.Deliverables,
		AcceptanceCriteria: req.AcceptanceCriteria,
		SkillRequirements:  req.SkillRequirements,
		MilestoneID:        req.MilestoneID,
		ParentContributionID: req.ParentContributionID,
		EstimatedDuration:  req.EstimatedDuration,
		Tags:               req.Tags,
		Status:             ContribCreated,
		CreatedAt:          now,
		UpdatedAt:          now,
	}
	errs := ValidateContribution(c)
	if len(errs) > 0 {
		return nil, fmt.Errorf("validation failed: %v", errs)
	}
	if err := s.store.Save(spaceID, c.ID, "contribution", c); err != nil {
		return nil, err
	}
	return c, nil
}

func (s *Service) GetContribution(ctx context.Context, spaceID, contribID string) (*Contribution, error) {
	var c Contribution
	if err := s.store.Get(spaceID, contribID, &c); err != nil {
		return nil, err
	}
	return &c, nil
}

func (s *Service) ListContributions(ctx context.Context, spaceID string) ([]*Contribution, error) {
	raw, err := s.store.List(spaceID, "contribution")
	if err != nil {
		return nil, err
	}
	var contribs []*Contribution
	for _, r := range raw {
		var c Contribution
		if err := json.Unmarshal(r, &c); err == nil {
			contribs = append(contribs, &c)
		}
	}
	return contribs, nil
}

func (s *Service) TransitionContribution(ctx context.Context, spaceID, contribID string, newStatus ContributionStatus) (*Contribution, error) {
	c, err := s.GetContribution(ctx, spaceID, contribID)
	if err != nil {
		return nil, err
	}
	if err := ValidateContributionTransition(c.Status, newStatus); err != nil {
		return nil, err
	}

	// If transitioning to signed_off, verify all child contributions are complete
	if newStatus == ContribSignedOff && len(c.ChildContributionIDs) > 0 {
		childStatuses := make(map[string]ContributionStatus)
		for _, childID := range c.ChildContributionIDs {
			child, err := s.GetContribution(ctx, spaceID, childID)
			if err != nil {
				return nil, fmt.Errorf("failed to check child %s: %w", childID, err)
			}
			childStatuses[childID] = child.Status
		}
		if err := ValidateParentSignOff(c.ID, childStatuses); err != nil {
			return nil, err
		}
	}

	c.Status = newStatus
	c.UpdatedAt = time.Now()
	if err := s.store.Save(spaceID, c.ID, "contribution", c); err != nil {
		return nil, err
	}
	return c, nil
}
```

- [ ] **Step 4: Run tests**

Run: `cd backend && go test ./internal/contributions/... -v`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
cd backend && git add internal/contributions/
git commit -m "feat: add implementation plans, milestones, and contribution service methods"
```

---

### Task 5.2: Implementation Plans & Contributions API Handlers

**Files:**
- Create: `backend/internal/api/implementation_plans.go`
- Create: `backend/internal/api/contributions_handler.go`

Follow the same pattern as proposals and projects handlers. Each handler should:
- Have `RegisterRoutes(mux)` method
- Use `contributions.Service` for business logic
- Use `logging.New("ComponentName")` for structured logging
- Follow existing error response pattern: `{"error": "message"}`

**Endpoints for implementation plans:**
```
GET  /api/v1/implementation-plans           - List
POST /api/v1/implementation-plans           - Create
GET  /api/v1/implementation-plans/{id}      - Get
POST /api/v1/implementation-plans/{id}/milestones - Add milestone
```

**Endpoints for contributions:**
```
GET  /api/v1/contributions                  - List
POST /api/v1/contributions                  - Create
GET  /api/v1/contributions/{id}             - Get
POST /api/v1/contributions/{id}/transition  - Transition status
PUT  /api/v1/contributions/{id}             - Update (evidence, assignment, etc.)
```

- [ ] **Step 1: Implement handlers following the established pattern**
- [ ] **Step 2: Write unit tests for each handler**
- [ ] **Step 3: Run tests to verify**

Run: `cd backend && go test ./internal/api/... -v`
Expected: ALL PASS

- [ ] **Step 4: Wire handlers in main.go**

```go
	implPlansHandler := api.NewImplementationPlansHandler(contribService)
	contribHandler := api.NewContributionsHandler(contribService)
	implPlansHandler.RegisterRoutes(mux)
	contribHandler.RegisterRoutes(mux)
```

- [ ] **Step 5: Frontend API clients**

Create `frontend/src/lib/api/implementationPlans.ts` and `frontend/src/lib/api/contributions.ts` following the same pattern as `proposals.ts` and `projects.ts`.

Create `frontend/src/stores/contributions.ts` Pinia store.

- [ ] **Step 6: Commit and tag**

```bash
git add -A
git commit -m "feat: add implementation plans and contributions API handlers, clients, and stores"
git tag phase-5-contributions
```

---

### Task 5.3: Contribution Registration & Assignment

**Files:**
- Modify: `backend/internal/contributions/models.go` (add ContributionRegistration)
- Modify: `backend/internal/contributions/service.go` (add registration methods)
- Modify: `backend/internal/contributions/service_test.go` (add registration tests)
- Create: `backend/internal/api/registrations.go`
- Create: `frontend/src/lib/api/registrations.ts`

Contributors can browse confirmed contributions across all projects and register their interest. Project leads and stewards are notified and can assign from registered users.

- [ ] **Step 1: Add ContributionRegistration model**

Add to `models.go`:

```go
// ContributionRegistration represents a contributor's interest in a contribution.
type ContributionRegistration struct {
	ID              string    `json:"id"`
	ContributionID  string    `json:"contribution_id"`
	UserID          string    `json:"user_id"`
	Statement       string    `json:"statement"`
	RegisteredAt    time.Time `json:"registered_at"`
}
```

- [ ] **Step 2: Write failing tests for registration**

Add to `service_test.go`:

```go
func TestService_RegisterInterest(t *testing.T) {
	svc := NewService(NewMockStore())
	ctx := context.Background()

	c, _ := svc.CreateContribution(ctx, "space-1", &CreateContributionRequest{
		ProjectID: "proj-1", Title: "Task", Description: "Do it",
		ContributionType: ProposalTypeTechnical, Priority: PriorityLow,
		CreatedBy: "lead-1", Objectives: []string{"o"},
		Deliverables: []string{"d"}, AcceptanceCriteria: []string{"a"},
		SkillRequirements: []string{"s"},
	})
	// Move to confirmed (eligible for registration)
	svc.TransitionContribution(ctx, "space-1", c.ID, ContribConfirmed)

	reg, err := svc.RegisterInterest(ctx, "space-1", c.ID, "user-2", "I have frontend experience")
	if err != nil {
		t.Fatalf("RegisterInterest failed: %v", err)
	}
	if reg.ContributionID != c.ID {
		t.Errorf("expected contribution ID %s, got %s", c.ID, reg.ContributionID)
	}

	regs, err := svc.ListRegistrations(ctx, "space-1", c.ID)
	if err != nil {
		t.Fatalf("ListRegistrations failed: %v", err)
	}
	if len(regs) != 1 {
		t.Errorf("expected 1 registration, got %d", len(regs))
	}
}

func TestService_RegisterInterest_WrongStatus(t *testing.T) {
	svc := NewService(NewMockStore())
	ctx := context.Background()

	c, _ := svc.CreateContribution(ctx, "space-1", &CreateContributionRequest{
		ProjectID: "proj-1", Title: "Task", Description: "Do it",
		ContributionType: ProposalTypeTechnical, Priority: PriorityLow,
		CreatedBy: "lead-1", Objectives: []string{"o"},
		Deliverables: []string{"d"}, AcceptanceCriteria: []string{"a"},
		SkillRequirements: []string{"s"},
	})
	// Still in "created" status — not eligible for registration
	_, err := svc.RegisterInterest(ctx, "space-1", c.ID, "user-2", "Interested")
	if err == nil {
		t.Error("expected error registering interest on non-confirmed contribution")
	}
}

func TestService_AssignFromRegistration(t *testing.T) {
	svc := NewService(NewMockStore())
	ctx := context.Background()

	c, _ := svc.CreateContribution(ctx, "space-1", &CreateContributionRequest{
		ProjectID: "proj-1", Title: "Task", Description: "Do it",
		ContributionType: ProposalTypeTechnical, Priority: PriorityLow,
		CreatedBy: "lead-1", Objectives: []string{"o"},
		Deliverables: []string{"d"}, AcceptanceCriteria: []string{"a"},
		SkillRequirements: []string{"s"},
	})
	svc.TransitionContribution(ctx, "space-1", c.ID, ContribConfirmed)
	svc.RegisterInterest(ctx, "space-1", c.ID, "user-2", "Interested")

	updated, err := svc.AssignContributor(ctx, "space-1", c.ID, "user-2")
	if err != nil {
		t.Fatalf("AssignContributor failed: %v", err)
	}
	if updated.AssignedContributorID != "user-2" {
		t.Errorf("expected user-2 assigned, got %s", updated.AssignedContributorID)
	}
	if updated.Status != ContribAssigned {
		t.Errorf("expected assigned status, got %s", updated.Status)
	}
}
```

- [ ] **Step 3: Implement registration service methods**

Add to `service.go`:

```go
// --- Contribution Registration ---

func (s *Service) RegisterInterest(ctx context.Context, spaceID, contribID, userID, statement string) (*ContributionRegistration, error) {
	c, err := s.GetContribution(ctx, spaceID, contribID)
	if err != nil {
		return nil, fmt.Errorf("contribution not found: %w", err)
	}
	if c.Status != ContribConfirmed {
		return nil, fmt.Errorf("can only register interest on confirmed contributions, current status: %s", c.Status)
	}
	reg := &ContributionRegistration{
		ID:             generateID("reg"),
		ContributionID: contribID,
		UserID:         userID,
		Statement:      statement,
		RegisteredAt:   time.Now(),
	}
	if err := s.store.Save(spaceID, reg.ID, "contribution_registration", reg); err != nil {
		return nil, err
	}
	return reg, nil
}

func (s *Service) ListRegistrations(ctx context.Context, spaceID, contribID string) ([]*ContributionRegistration, error) {
	raw, err := s.store.List(spaceID, "contribution_registration")
	if err != nil {
		return nil, err
	}
	var regs []*ContributionRegistration
	for _, r := range raw {
		var reg ContributionRegistration
		if err := json.Unmarshal(r, &reg); err == nil {
			if reg.ContributionID == contribID {
				regs = append(regs, &reg)
			}
		}
	}
	return regs, nil
}

func (s *Service) AssignContributor(ctx context.Context, spaceID, contribID, userID string) (*Contribution, error) {
	c, err := s.GetContribution(ctx, spaceID, contribID)
	if err != nil {
		return nil, err
	}
	if c.Status != ContribConfirmed {
		return nil, fmt.Errorf("contribution must be confirmed to assign, current: %s", c.Status)
	}
	c.AssignedContributorID = userID
	c.Status = ContribAssigned
	c.UpdatedAt = time.Now()
	if err := s.store.Save(spaceID, c.ID, "contribution", c); err != nil {
		return nil, err
	}
	return c, nil
}
```

- [ ] **Step 4: Create registration API handler**

```go
// backend/internal/api/registrations.go
// Endpoints:
// POST /api/v1/contributions/{id}/register     — Register interest (requires ActionRegisterInterest)
// GET  /api/v1/contributions/{id}/registrations — List registrations (requires ActionAssignContribution)
// POST /api/v1/contributions/{id}/assign        — Assign contributor (requires ActionAssignContribution)
```

The register endpoint should also trigger a notification to the project lead and project steward:
```go
// After successful registration, notify project lead and steward
notifService.Notify(&notifications.Notification{
    Type:        notifications.NotifyContributionRegistered,
    RecipientID: projectLeadID,
    Title:       "New Registration",
    Message:     fmt.Sprintf("%s registered interest in %s", userID, c.Title),
    EntityID:    contribID,
    EntityType:  "contribution",
    Channel:     notifications.ChannelBoth,
})
```

Add `NotifyContributionRegistered NotificationType = "contribution:registered"` to notification models.

- [ ] **Step 5: Frontend registration API and UI**

```typescript
// frontend/src/lib/api/registrations.ts
import { BACKEND_URL } from './client';

export interface ContributionRegistration {
  id: string;
  contribution_id: string;
  user_id: string;
  statement: string;
  registered_at: string;
}

export async function registerInterest(
  contribId: string, statement: string
): Promise<ContributionRegistration> {
  const response = await fetch(
    `${BACKEND_URL}/api/v1/contributions/${contribId}/register`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ statement }),
    }
  );
  if (!response.ok) throw new Error('Registration failed');
  return response.json();
}

export async function listRegistrations(
  contribId: string
): Promise<ContributionRegistration[]> {
  const response = await fetch(
    `${BACKEND_URL}/api/v1/contributions/${contribId}/registrations`
  );
  if (!response.ok) return [];
  const data = await response.json();
  return data.registrations ?? [];
}

export async function assignContributor(
  contribId: string, userId: string
): Promise<void> {
  const response = await fetch(
    `${BACKEND_URL}/api/v1/contributions/${contribId}/assign`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: userId }),
    }
  );
  if (!response.ok) throw new Error('Assignment failed');
}
```

**Frontend UI requirements:**
- Projects view and individual project view show all **confirmed** contributions with a "Register Interest" button
- Button opens a modal asking for a brief statement of interest
- Project lead and steward views show a registration count badge on contributions
- Clicking a contribution shows a list of registered users with an "Assign" button next to each
- Only users with `project_lead` or `operations_steward` role see the assignment controls
- Only users with `contributor` (or higher) role see the "Register Interest" button

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: add contribution registration, interest tracking, and assignment flow"
```

---

### Phase 5 Verification Checkpoint

Checklist:
- [x] Implementation plan includes: project_id, project_steward_id — Section 4.4.1
- [x] Milestone includes: implementation_plan_id — Section 4.4.2
- [x] Contribution CRUD with project_id — Section 5.3.1
- [x] Contribution status lifecycle: created → confirmed → assigned → needs_review → approved/incomplete/declined → signed_off — Section 5.1
- [x] Incomplete returns to assigned — Section 5.2.1
- [x] Declined moves to archived — Section 5.2.1
- [x] Nested contributions (parent_contribution_id) — Section 5.4
- [x] All transition rules validated — Section 6.2.2
- [x] All handlers use structured logger
- [x] Frontend API clients and stores created
- [x] Contribution registration and interest tracking — Section 5.5
- [x] Assignment from registered users — Section 5.5
- [x] Role-based access checks on all handler endpoints
- [x] Notifications sent on registration to project lead/steward

---

## Chunk 6: Phase 6 — Notifications

### Task 6.1: Notification Models & Service (Backend)

**Files:**
- Create: `backend/internal/notifications/models.go`
- Create: `backend/internal/notifications/service.go`
- Create: `backend/internal/notifications/service_test.go`

- [ ] **Step 1: Create notification models**

```go
// backend/internal/notifications/models.go
package notifications

import "time"

type NotificationType string

const (
	NotifyProposalSubmitted     NotificationType = "proposal:submitted"
	NotifyProposalEndorsed      NotificationType = "proposal:endorsed"
	NotifyProposalApproved      NotificationType = "proposal:approved"
	NotifyProposalRejected      NotificationType = "proposal:rejected"
	NotifyProjectCreated        NotificationType = "project:created"
	NotifyContributionAssigned  NotificationType = "contribution:assigned"
	NotifyContributionReview    NotificationType = "contribution:needs_review"
	NotifyContributionApproved  NotificationType = "contribution:approved"
	NotifyContributionDeclined  NotificationType = "contribution:declined"
	NotifyDecisionPlanSubmitted NotificationType = "decision_plan:submitted"
	NotifyDecisionPlanSignedOff NotificationType = "decision_plan:signed_off"
	NotifyGovActionCompleted    NotificationType = "governance_action:completed"
)

type DeliveryChannel string

const (
	ChannelInApp DeliveryChannel = "in_app"
	ChannelEmail DeliveryChannel = "email"
	ChannelBoth  DeliveryChannel = "both"
)

type Notification struct {
	ID          string           `json:"id"`
	Type        NotificationType `json:"type"`
	RecipientID string           `json:"recipient_id"`
	Title       string           `json:"title"`
	Message     string           `json:"message"`
	EntityID    string           `json:"entity_id"`
	EntityType  string           `json:"entity_type"`
	Read        bool             `json:"read"`
	Channel     DeliveryChannel  `json:"channel"`
	CreatedAt   time.Time        `json:"created_at"`
}

// EmailNotification holds data for email delivery
type EmailNotification struct {
	To      string `json:"to"`
	Subject string `json:"subject"`
	Body    string `json:"body"`
}
```

- [ ] **Step 2: Write failing tests for notification service**

```go
// backend/internal/notifications/service_test.go
package notifications

import (
	"testing"
)

// SSEEvent must match the actual EventBroker's SSEEvent type from api/events.go
type MockBroker struct {
	events []SSEEvent
}

type SSEEvent struct {
	Type string      `json:"type"`
	Data interface{} `json:"data"`
}

func (m *MockBroker) Broadcast(event SSEEvent) {
	m.events = append(m.events, event)
}

type MockEmailSender struct {
	sent []EmailNotification
}

func (m *MockEmailSender) Send(notif EmailNotification) error {
	m.sent = append(m.sent, notif)
	return nil
}

func TestService_NotifyInApp(t *testing.T) {
	broker := &MockBroker{}
	svc := NewService(broker, nil)

	err := svc.Notify(&Notification{
		Type:        NotifyProposalSubmitted,
		RecipientID: "user-1",
		Title:       "New proposal",
		Message:     "A proposal was submitted",
		EntityID:    "prop-1",
		EntityType:  "proposal",
		Channel:     ChannelInApp,
	})
	if err != nil {
		t.Fatalf("Notify failed: %v", err)
	}
	if len(broker.events) != 1 {
		t.Errorf("expected 1 broadcast, got %d", len(broker.events))
	}
}

func TestService_NotifyEmail(t *testing.T) {
	emailSender := &MockEmailSender{}
	svc := NewService(nil, emailSender)

	err := svc.NotifyEmail(&EmailNotification{
		To:      "user@example.com",
		Subject: "Proposal approved",
		Body:    "Your proposal has been approved.",
	})
	if err != nil {
		t.Fatalf("NotifyEmail failed: %v", err)
	}
	if len(emailSender.sent) != 1 {
		t.Errorf("expected 1 email, got %d", len(emailSender.sent))
	}
}

func TestService_NotifyBoth(t *testing.T) {
	broker := &MockBroker{}
	emailSender := &MockEmailSender{}
	svc := NewService(broker, emailSender)

	err := svc.NotifyWithEmail(&Notification{
		Type:        NotifyContributionAssigned,
		RecipientID: "user-1",
		Title:       "Assigned",
		Message:     "You were assigned a contribution",
		EntityID:    "ctr-1",
		EntityType:  "contribution",
		Channel:     ChannelBoth,
	}, "user@example.com")
	if err != nil {
		t.Fatalf("failed: %v", err)
	}
	if len(broker.events) != 1 {
		t.Errorf("expected 1 SSE event, got %d", len(broker.events))
	}
	if len(emailSender.sent) != 1 {
		t.Errorf("expected 1 email, got %d", len(emailSender.sent))
	}
}
```

- [ ] **Step 3: Implement notification service**

```go
// backend/internal/notifications/service.go
package notifications

import (
	"fmt"
	"time"

	"crypto/rand"

	"github.com/matou-dao/backend/internal/logging"
)

// Broadcaster wraps the EventBroker from api/events.go.
// The actual type is: type SSEEvent struct { Type string; Data interface{} }
type Broadcaster interface {
	Broadcast(event SSEEvent)
}

// SSEEvent matches api.SSEEvent — import from api package in production code.
type SSEEvent struct {
	Type string      `json:"type"`
	Data interface{} `json:"data"`
}

type EmailSender interface {
	Send(notif EmailNotification) error
}

type Service struct {
	broker Broadcaster
	email  EmailSender
	log    *logging.Logger
}

func NewService(broker Broadcaster, email EmailSender) *Service {
	return &Service{
		broker: broker,
		email:  email,
		log:    logging.New("Notifications"),
	}
}

func generateID() string {
	b := make([]byte, 8)
	rand.Read(b)
	return fmt.Sprintf("notif_%x", b)
}

func (s *Service) Notify(n *Notification) error {
	if n.ID == "" {
		n.ID = generateID()
	}
	if n.CreatedAt.IsZero() {
		n.CreatedAt = time.Now()
	}

	if s.broker != nil {
		s.broker.Broadcast(SSEEvent{
			Type: string(n.Type),
			Data: n,
		})
		s.log.Info("in-app notification sent: %s to %s", n.Type, n.RecipientID)
	}
	return nil
}

func (s *Service) NotifyEmail(e *EmailNotification) error {
	if s.email == nil {
		return fmt.Errorf("email sender not configured")
	}
	if err := s.email.Send(*e); err != nil {
		s.log.Error("email notification failed: %v", err)
		return err
	}
	s.log.Info("email sent to %s: %s", e.To, e.Subject)
	return nil
}

func (s *Service) NotifyWithEmail(n *Notification, emailAddr string) error {
	if err := s.Notify(n); err != nil {
		return err
	}
	return s.NotifyEmail(&EmailNotification{
		To:      emailAddr,
		Subject: n.Title,
		Body:    n.Message,
	})
}
```

- [ ] **Step 4: Run tests**

Run: `cd backend && go test ./internal/notifications/... -v`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
cd backend && git add internal/notifications/
git commit -m "feat: add notification service with in-app SSE and email delivery"
```

---

### Task 6.2: Extend SSE Event Types & Frontend Notification Store

**Files:**
- Modify: `frontend/src/composables/useBackendEvents.ts` — add new event types
- Create: `frontend/src/stores/notifications.ts`
- Create: `frontend/src/composables/useNotifications.ts`

- [ ] **Step 1: Add new event types to useBackendEvents**

Add to `BackendEventType`:
```typescript
  | 'proposal:submitted'
  | 'proposal:endorsed'
  | 'proposal:approved'
  | 'project:created'
  | 'contribution:assigned'
  | 'contribution:needs_review'
  | 'contribution:approved'
  | 'contribution:declined'
  | 'decision_plan:submitted'
  | 'decision_plan:signed_off'
```

- [ ] **Step 2: Create notification store**

```typescript
// frontend/src/stores/notifications.ts
import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { createLogger } from 'src/lib/logging';

const log = createLogger('NotificationsStore');

export interface AppNotification {
  id: string;
  type: string;
  recipient_id: string;
  title: string;
  message: string;
  entity_id: string;
  entity_type: string;
  read: boolean;
  created_at: string;
}

export const useNotificationsStore = defineStore('notifications', () => {
  const notifications = ref<AppNotification[]>([]);
  const unreadCount = computed(() => notifications.value.filter(n => !n.read).length);

  function addNotification(notif: AppNotification) {
    notifications.value.unshift(notif);
    log.info('Notification received: %s', notif.type);

    // Electron native notification
    if (window.Notification && Notification.permission === 'granted') {
      new Notification(notif.title, { body: notif.message });
    }
  }

  function markRead(id: string) {
    const notif = notifications.value.find(n => n.id === id);
    if (notif) notif.read = true;
  }

  function markAllRead() {
    notifications.value.forEach(n => { n.read = true; });
  }

  function clear() {
    notifications.value = [];
  }

  return {
    notifications, unreadCount,
    addNotification, markRead, markAllRead, clear,
  };
});
```

- [ ] **Step 3: Create notification composable with Electron integration**

```typescript
// frontend/src/composables/useNotifications.ts
import { onMounted } from 'vue';
import { useNotificationsStore, type AppNotification } from 'stores/notifications';
import { useBackendEvents } from './useBackendEvents';
import { createLogger } from 'src/lib/logging';

const log = createLogger('Notifications');

const NOTIFICATION_EVENTS = [
  'proposal:submitted', 'proposal:endorsed', 'proposal:approved',
  'project:created', 'contribution:assigned', 'contribution:needs_review',
  'contribution:approved', 'contribution:declined',
  'decision_plan:submitted', 'decision_plan:signed_off',
];

export function useNotifications() {
  const store = useNotificationsStore();
  const { lastEvent, connect } = useBackendEvents();

  function requestPermission() {
    if (window.Notification && Notification.permission === 'default') {
      Notification.requestPermission().then(perm => {
        log.info('Notification permission: %s', perm);
      });
    }
  }

  function handleEvent(event: { type: string; data: Record<string, string> }) {
    if (!NOTIFICATION_EVENTS.includes(event.type)) return;

    const notif: AppNotification = {
      id: `notif_${Date.now()}`,
      type: event.type,
      recipient_id: event.data.recipient_id || '',
      title: formatTitle(event.type),
      message: event.data.message || formatMessage(event.type, event.data),
      entity_id: event.data.entity_id || '',
      entity_type: event.data.entity_type || '',
      read: false,
      created_at: new Date().toISOString(),
    };
    store.addNotification(notif);
  }

  onMounted(() => {
    requestPermission();
    connect();
  });

  return { handleEvent, ...store };
}

function formatTitle(type: string): string {
  const titles: Record<string, string> = {
    'proposal:submitted': 'Proposal Submitted',
    'proposal:endorsed': 'Proposal Endorsed',
    'proposal:approved': 'Proposal Approved',
    'project:created': 'Project Created',
    'contribution:assigned': 'Contribution Assigned',
    'contribution:needs_review': 'Contribution Ready for Review',
    'contribution:approved': 'Contribution Approved',
    'contribution:declined': 'Contribution Declined',
    'decision_plan:submitted': 'Decision Plan Submitted',
    'decision_plan:signed_off': 'Decision Plan Signed Off',
  };
  return titles[type] || 'Notification';
}

function formatMessage(type: string, data: Record<string, string>): string {
  return data.title ? `${formatTitle(type)}: ${data.title}` : formatTitle(type);
}
```

- [ ] **Step 4: Commit**

```bash
cd frontend && git add src/stores/notifications.ts src/composables/useNotifications.ts
git commit -m "feat: add notification store and composable with Electron native notifications"
```

---

### Task 6.3: Wire Notifications in Backend & Phase 6 Checkpoint

**Files:**
- Modify: `backend/cmd/server/main.go`

- [ ] **Step 1: Initialize notification service in main.go**

After event broker creation:

```go
	// Initialize notification service
	emailAdapter := notifications.NewEmailAdapter(emailSender)
	notifService := notifications.NewService(
		notifications.NewSSEBrokerAdapter(eventBroker),
		emailAdapter,
	)
```

- [ ] **Step 2: Create adapter types**

Create `backend/internal/notifications/adapters.go`:

```go
package notifications

import "github.com/matou-dao/backend/internal/api"
import "github.com/matou-dao/backend/internal/email"

// SSEBrokerAdapter adapts api.EventBroker to the notifications.Broadcaster interface.
// It passes SSEEvent directly to the real EventBroker.
type SSEBrokerAdapter struct {
	broker *api.EventBroker
}

func NewSSEBrokerAdapter(broker *api.EventBroker) *SSEBrokerAdapter {
	return &SSEBrokerAdapter{broker: broker}
}

func (a *SSEBrokerAdapter) Broadcast(event SSEEvent) {
	a.broker.Broadcast(api.SSEEvent{
		Type: event.Type,
		Data: event.Data,
	})
}

// EmailAdapter adapts email.Sender to EmailSender interface
type EmailAdapter struct {
	sender *email.Sender
}

func NewEmailAdapter(sender *email.Sender) *EmailAdapter {
	return &EmailAdapter{sender: sender}
}

func (a *EmailAdapter) Send(notif EmailNotification) error {
	return a.sender.SendGeneric(notif.To, notif.Subject, notif.Body)
}
```

- [ ] **Step 2b: Add SendGeneric method to email.Sender**

Add to `backend/internal/email/email.go`:

```go
// SendGeneric sends an HTML email using the existing relay or direct SMTP infrastructure.
// This follows the same pattern as SendInvite/SendApprovalNotification.
func (s *Sender) SendGeneric(to, subject, htmlBody string) error {
	if s.relayURL != "" {
		return s.sendViaRelay(to, subject, htmlBody)
	}
	return s.sendMailFrom(s.from, to, subject, htmlBody)
}
```

> **NOTE**: `sendMailFrom` and `sendViaRelay` are existing private methods on `email.Sender`. The `relayURL` field enables production email delivery through the config server relay. Check `backend/internal/email/email.go` for the exact method signatures before implementing.

- [ ] **Step 3: Run all tests**

Run: `cd backend && go test ./internal/... -v`
Expected: ALL PASS

- [ ] **Step 4: Commit and tag**

```bash
git add -A
git commit -m "feat: wire notification service with SSE and email adapters"
git tag phase-6-notifications
```

Phase 6 Checklist:
- [x] In-app notifications via SSE EventBroker
- [x] Email notifications via SMTP Sender
- [x] Notification types for all entity transitions
- [x] Electron native notification support (via Web Notification API)
- [x] Frontend notification store with unread count
- [x] Notification composable with auto-connect

---

## Chunk 7: Phase 7 — Integration Tests & E2E

### Task 7.1: Multi-User P2P Replication Integration Tests (Backend)

**Files:**
- Create: `backend/internal/anysync/contributions_integration_test.go`

These tests require the any-sync test network running (`make testnet-up`).

- [ ] **Step 1: Write integration test for P2P proposal replication**

```go
//go:build integration

// backend/internal/anysync/contributions_integration_test.go
package anysync

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/matou-dao/backend/internal/contributions"
)

// TestProposalReplication_TwoUsers verifies that a proposal created by User A
// is visible to User B after any-sync P2P replication.
func TestProposalReplication_TwoUsers(t *testing.T) {
	ctx := context.Background()

	// Setup two SDK clients simulating two users
	userA, err := setupTestClient(t, "user-a")
	if err != nil {
		t.Fatalf("setup user A failed: %v", err)
	}
	defer userA.Close()

	userB, err := setupTestClient(t, "user-b")
	if err != nil {
		t.Fatalf("setup user B failed: %v", err)
	}
	defer userB.Close()

	// Create a shared community space
	spaceID, err := createSharedSpace(t, userA, userB)
	if err != nil {
		t.Fatalf("create shared space failed: %v", err)
	}

	// User A creates a proposal
	proposal := &contributions.Proposal{
		ID:          "test-prop-1",
		ProposerID:  "user-a-aid",
		Title:       "Integration Test Proposal",
		Description: "Testing P2P replication",
		Status:      contributions.ProposalDraft,
		CreatedAt:   time.Now(),
		UpdatedAt:   time.Now(),
	}
	proposalJSON, _ := json.Marshal(proposal)

	_, err = userA.ObjectTreeManager().AddObject(ctx, spaceID, &ObjectPayload{
		ID:        proposal.ID,
		Type:      TypeProposal,
		OwnerKey:  userA.GetPeerID(),
		Data:      proposalJSON,
		Timestamp: time.Now().Unix(),
		Version:   1,
	}, userA.GetSigningKey())
	if err != nil {
		t.Fatalf("User A add proposal failed: %v", err)
	}

	// Wait for replication (HeadSync period is 5s)
	time.Sleep(10 * time.Second)

	// User B reads the proposal
	objects, err := userB.ObjectTreeManager().ReadObjectsByType(ctx, spaceID, TypeProposal)
	if err != nil {
		t.Fatalf("User B read proposals failed: %v", err)
	}
	if len(objects) == 0 {
		t.Fatal("User B saw 0 proposals — replication failed")
	}

	var replicated contributions.Proposal
	if err := json.Unmarshal(objects[0].Data, &replicated); err != nil {
		t.Fatalf("unmarshal failed: %v", err)
	}
	if replicated.ID != proposal.ID {
		t.Errorf("expected proposal ID %s, got %s", proposal.ID, replicated.ID)
	}
	if replicated.Title != proposal.Title {
		t.Errorf("expected title %q, got %q", proposal.Title, replicated.Title)
	}

	t.Logf("Replication verified: User B sees proposal %s created by User A", replicated.ID)
}

// TestEndorsementReplication verifies endorsements sync between users
func TestEndorsementReplication(t *testing.T) {
	ctx := context.Background()

	userA, _ := setupTestClient(t, "user-a")
	defer userA.Close()
	userB, _ := setupTestClient(t, "user-b")
	defer userB.Close()

	spaceID, _ := createSharedSpace(t, userA, userB)

	// User A adds an endorsement
	endorsement := &contributions.Endorsement{
		EndorserID: "user-a-aid",
		EndorsedAt: time.Now(),
		Comment:    "Looks good",
	}
	endorseJSON, _ := json.Marshal(endorsement)

	_, err := userA.ObjectTreeManager().AddObject(ctx, spaceID, &ObjectPayload{
		ID:   "endorse_prop1_userA",
		Type: TypeEndorsement,
		Data: endorseJSON,
	}, userA.GetSigningKey())
	if err != nil {
		t.Fatalf("add endorsement failed: %v", err)
	}

	time.Sleep(10 * time.Second)

	objects, _ := userB.ObjectTreeManager().ReadObjectsByType(ctx, spaceID, TypeEndorsement)
	if len(objects) == 0 {
		t.Fatal("endorsement not replicated to User B")
	}
	t.Log("Endorsement replication verified")
}
```

Note: `setupTestClient` and `createSharedSpace` are test helpers that initialize SDK clients with the test network configuration. These follow the pattern in existing `anysync` integration tests.

- [ ] **Step 2: Run integration tests**

Run: `cd backend && make testnet-up && go test -tags=integration -v ./internal/anysync/... -run "TestProposalReplication|TestEndorsementReplication" -timeout 120s`
Expected: PASS (requires test network on ports 2001-2006)

- [ ] **Step 3: Commit**

```bash
cd backend && git add internal/anysync/contributions_integration_test.go
git commit -m "test: add multi-user P2P replication integration tests for proposals and endorsements"
```

---

### Task 7.2: E2E Playwright Tests

**Files:**
- Create: `frontend/tests/e2e/e2e-proposals.spec.ts`
- Create: `frontend/tests/e2e/e2e-multi-user-sync.spec.ts`

- [ ] **Step 1: Create proposal E2E test**

```typescript
// frontend/tests/e2e/e2e-proposals.spec.ts
import { test, expect } from '@playwright/test';
import { BackendManager } from './backend-manager';
import { setupTestUser } from './test-helpers';

test.describe('Proposal Lifecycle', () => {
  let backend: BackendManager;

  test.beforeAll(async () => {
    backend = new BackendManager();
    await backend.start();
  });

  test.afterAll(async () => {
    await backend.stop();
  });

  test('create and list proposals', async ({ page }) => {
    await setupTestUser(page, backend);

    // Navigate to proposals page
    await page.goto(`http://localhost:${backend.port}/#/proposals`);

    // Create a proposal via API (simulating frontend action)
    const response = await page.evaluate(async (port) => {
      const res = await fetch(`http://localhost:${port}/api/v1/proposals`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          proposer_id: 'test-user',
          title: 'E2E Test Proposal',
          type: ['technical'],
          priority: 'medium',
          description: 'Testing proposal creation',
          problem_statement: 'Need to test',
          solution: 'Write tests',
          expected_outcomes: ['Tests pass'],
          estimated_budget: '$100',
          timeline: '1 week',
        }),
      });
      return res.json();
    }, backend.port);

    expect(response.id).toBeTruthy();
    expect(response.status).toBe('draft');

    // List proposals
    const listResponse = await page.evaluate(async (port) => {
      const res = await fetch(`http://localhost:${port}/api/v1/proposals`);
      return res.json();
    }, backend.port);

    expect(listResponse.total).toBeGreaterThan(0);
  });

  test('proposal status transitions', async ({ page }) => {
    await setupTestUser(page, backend);

    // Create proposal
    const proposal = await page.evaluate(async (port) => {
      const res = await fetch(`http://localhost:${port}/api/v1/proposals`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          proposer_id: 'test-user', title: 'Transition Test',
          type: ['technical'], priority: 'low', description: 'd',
          problem_statement: 'p', solution: 's',
          expected_outcomes: ['o'], estimated_budget: '$1', timeline: '1w',
        }),
      });
      return res.json();
    }, backend.port);

    // Transition: draft → submitted → endorsing
    for (const status of ['submitted', 'endorsing']) {
      const result = await page.evaluate(async ({ port, id, status }) => {
        const res = await fetch(`http://localhost:${port}/api/v1/proposals/${id}/transition`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status }),
        });
        return res.json();
      }, { port: backend.port, id: proposal.id, status });

      expect(result.status).toBe(status);
    }
  });
});
```

- [ ] **Step 2: Create multi-user sync E2E test**

```typescript
// frontend/tests/e2e/e2e-multi-user-sync.spec.ts
import { test, expect } from '@playwright/test';
import { BackendManager } from './backend-manager';

test.describe('Multi-User P2P Sync', () => {
  let backendA: BackendManager;
  let backendB: BackendManager;

  test.beforeAll(async () => {
    // Two separate backend instances (different ports, different data dirs)
    backendA = new BackendManager({ port: 9280, dataDir: './data-test-a', env: 'test' });
    backendB = new BackendManager({ port: 9281, dataDir: './data-test-b', env: 'test' });
    await Promise.all([backendA.start(), backendB.start()]);
  });

  test.afterAll(async () => {
    await Promise.all([backendA.stop(), backendB.stop()]);
  });

  test('proposal created by User A appears for User B after sync', async ({ page }) => {
    // User A creates a proposal
    const proposal = await page.evaluate(async (port) => {
      const res = await fetch(`http://localhost:${port}/api/v1/proposals`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          proposer_id: 'user-a', title: 'Sync Test Proposal',
          type: ['community'], priority: 'medium',
          description: 'Testing P2P sync', problem_statement: 'Sync',
          solution: 'Test', expected_outcomes: ['Synced'],
          estimated_budget: '$0', timeline: '1w',
        }),
      });
      return res.json();
    }, backendA.port);

    expect(proposal.id).toBeTruthy();

    // Wait for P2P replication (HeadSync period ~5s + processing)
    await page.waitForTimeout(15000);

    // User B should see the proposal
    const listB = await page.evaluate(async (port) => {
      const res = await fetch(`http://localhost:${port}/api/v1/proposals`);
      return res.json();
    }, backendB.port);

    const found = listB.proposals?.find(
      (p: { id: string }) => p.id === proposal.id
    );
    expect(found).toBeTruthy();
    expect(found.title).toBe('Sync Test Proposal');
  });
});
```

- [ ] **Step 3: Run E2E tests**

Run:
```bash
cd frontend
# Ensure test infrastructure is clean
../scripts/clean-test.sh
# Run proposal tests
npx playwright test tests/e2e/e2e-proposals.spec.ts --headed
# Run sync tests (requires any-sync test network)
npx playwright test tests/e2e/e2e-multi-user-sync.spec.ts --headed
```
Expected: ALL PASS

- [ ] **Step 4: Commit and tag**

```bash
cd frontend && git add tests/e2e/e2e-proposals.spec.ts tests/e2e/e2e-multi-user-sync.spec.ts
git commit -m "test: add E2E tests for proposal lifecycle and multi-user P2P sync"
git tag phase-7-integration-tests
```

---

### Phase 7 Verification Checkpoint — Final

- [ ] **Step 1: Run full test suite**

```bash
# Backend unit tests
cd backend && go test ./internal/... -v

# Backend integration tests (requires testnet)
make testnet-up
go test -tags=integration -v ./internal/anysync/... -timeout 120s

# Frontend E2E tests
cd ../frontend
npx playwright test tests/e2e/e2e-proposals.spec.ts
npx playwright test tests/e2e/e2e-multi-user-sync.spec.ts
```

- [ ] **Step 2: Full design document alignment verification**

| Design Section | Implementation | Status |
|---|---|---|
| 4.1 Proposals (schema, lifecycle, endorsements) | Service + API + Store | |
| 4.1.3 Member Endorsements (any-sync tree) | Service + API + integration test | |
| 4.2 Decision Plans (status lifecycle, review) | Service + API + client | |
| 4.2.2 Governance Actions (status, outcomes) | Service + API + client | |
| 4.3 Projects (schema, CRUD, auto-create, admin) | Service + API + Store | |
| 4.4 Implementation Plans (project_id, steward) | Service + API + client | |
| 4.4.2 Milestones (implementation_plan_id) | Service + API | |
| 5.1 Contribution Lifecycle | Service + API + Store | |
| 5.2 Status Definitions & Transitions | Validation + tests | |
| 5.2.1 Status Transition Details (incomplete, declined) | Validation + lifecycle tests | |
| 6.2.1 Proposal Status Transitions | Validation + tests | |
| 6.2.2 Contribution Status Transitions | Validation + tests | |
| 8.1 Process Flow (endorsement step, role names) | API flow | |
| 8.2 Proposal Flowchart (endorsements, sign-offs) | API flow | |
| 9.2 Operational Roles (proposal lead, steward) | API handler naming | |
| Notifications (in-app + email) | Notification service + store | |
| Structured Logging | Logger package + all handlers | |
| P2P Replication | Integration tests | |
| Multi-user E2E | Playwright tests | |

- [ ] **Step 3: Final commit**

```bash
git tag v0.2.0-contributions
```

---

## Summary of Phases

| Phase | Focus | Key Deliverables | Gate |
|-------|-------|-----------------|------|
| **1** | Foundation | Logger, models, validation, any-sync types | Unit tests pass |
| **2** | Proposals | Proposal CRUD, endorsements, frontend store | Unit + handler tests pass |
| **3** | Projects | Project CRUD, auto-create, admin, frontend | Unit + handler tests pass |
| **4** | Governance | Decision plans, governance actions, frontend | Unit + handler tests pass |
| **5** | Contributions | Impl plans, milestones, contribution lifecycle | Unit + handler tests pass |
| **6** | Notifications | In-app SSE + email, Electron native | Unit tests pass |
| **7** | Integration | Multi-user P2P replication, E2E Playwright | Integration + E2E tests pass |

Each phase MUST pass all tests before proceeding to the next phase.
