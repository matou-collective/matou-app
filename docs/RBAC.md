# Matou RBAC Reference

**Who can see and do what in the Matou app — and how much of it is actually enforced.**

- Generated: 2026-08-06, verified against code on branch `main` (commit `0ce0f22`).
- Method: one research/writer agent per feature area, followed by an adversarial reviewer agent that re-verified every permission-matrix cell and `file:line` citation against the code. Matrices reflect **what the code does**, not what design docs claim.
- Sources of truth: `backend/internal/contributions/roles.go` (policy table), `backend/internal/api/rbac.go` (middleware + role lookup), per-handler checks in `backend/internal/api/`, and frontend gating in `frontend/src/composables/`.

## How to read this document

Each feature section has:

1. **Permission Matrix** — actions x the 10 contribution-system roles (what the code allows).
2. **Implementation Status** — per action: the policy entry, whether the backend actually enforces it, whether the frontend gates it, an overall level, and `file:line` evidence.
3. **Notes & Gaps** — drift from design docs and enforcement holes.

### Implementation levels

| Level | Meaning |
|---|---|
| ✅ Fully enforced | Backend RBAC check on the endpoint **and** frontend UI gating |
| 🔷 Backend-only | Backend enforces; frontend does not gate (UI may show actions that will fail) |
| 🔶 Frontend-only | UI hides/disables the action but the API endpoint has **no** role check — anyone with an AID can call it |
| ⚠️ Policy not enforced | An `Action` constant / policy entry exists but is `allRoles` or the endpoint is never wired through `RequireAction`; effectively unrestricted |
| 📄 Documented only | Appears in design docs but has no code implementation |

### Global security context

Two facts frame every matrix below (details in [Role Model & Resolution](#role-model--resolution)):

- **Identity is a bare `X-User-AID` header** with no cryptographic verification. The backend is designed to run as a local child process of the Electron app; the only guard is a localhost check active in bundled mode.
- **Most actions in the policy table map to `allRoles`** — the restricted set is small (sign-offs, proposal lifecycle, archive/unassign, rewards, project completion approval). Where a design doc claims a tighter rule than the code enforces, the section says so.

## Contents

- [Role Model & Resolution](#role-model--resolution)
- [Projects](#projects)
- [Contributions Lifecycle](#contributions-lifecycle)
- [Plans, Milestones & Governance Actions](#plans-milestones--governance-actions)
- [Proposals & Endorsements](#proposals--endorsements)
- [Membership, Registration & Credentials](#membership-registration--credentials)
- [Communication & Content (Notices, Chat, Events, Files)](#communication--content-notices-chat-events-files)
- [Spaces, Sync & Admin Infrastructure](#spaces-sync--admin-infrastructure)
- [Appendix: Known Gaps & Design-Doc Drift](#appendix-known-gaps--design-doc-drift)

---

## Role Model & Resolution

This section documents the role system itself: the two parallel role vocabularies (KERI membership-credential roles and internal contribution-system roles), how a request's roles are resolved at runtime, how roles are granted and changed, and how the frontend learns them. Enforcement machinery lives in `backend/internal/api/rbac.go` (middleware), `backend/internal/contributions/roles.go` (role/action policy tables + `MapKERIRole`), `backend/internal/contributions/role_store.go` (profile-based lookup), with the lookup chain assembled in `backend/cmd/server/main.go:517-521`. The frontend's role awareness lives in `frontend/src/stores/identity.ts` (admin state) and per-page derivations (`useProjectPermissions.ts`, `useAdminAccess.ts`).

The headline caveat, verified in code: **authentication is a bare `X-User-AID` HTTP header with no cryptographic verification of any kind** (`rbac.go:31` reads the header directly; there is no signature check anywhere in the middleware path). The backend's own comment confirms the model: "The Matou backend is designed to run as a local child process of the Electron app and **has no authentication layer**" (`middleware.go:191-193`). The only mitigation is `LocalhostGuard` (`middleware.go:195-218`, applied globally at `main.go:761`), which rejects non-loopback requests — and only when `MATOU_CORS_MODE=bundled`; in dev/test it is a no-op. Any local process can therefore impersonate any AID.

### 1. The 10 contribution-system roles

Defined in `backend/internal/contributions/roles.go:8-19`. Purpose is inferred from the `actionPermissions` policy table (`roles.go:114-145`) — note that most actions map to `allRoles`, so many roles differ only on a handful of restricted actions:

| Role | Purpose (as actually expressed in the policy table) |
|---|---|
| `member` | Baseline. **Every resolvable AID gets at least this** (`role_store.go:70-72`). Grants all `allRoles` actions (create/edit/delete project, create contribution, assign, approve, offer, review, etc.). |
| `contributor` | Workflow participant. Adds nothing beyond `member` in the policy table (all its actions are `allRoles`). |
| `project_lead` | Archive project/milestone/contribution, unassign, edit milestone (`leadStewardScope`, roles.go:110-112, 137-141); submit project completion (roles.go:142). |
| `project_steward` | Sign off contributions and plans (roles.go:122, 129); proposal sign-off/reject/edit/withdraw (roles.go:133-136); approve/reject project completion (roles.go:143-144). |
| `operations_steward` | Everything a project steward can, plus `reward_contribution` (roles.go:123). Part of every restricted scope. |
| `community_steward` | Proposal lifecycle actions only (sign-off/reject/edit/withdraw, roles.go:133-136). |
| `tech_steward` | **No restricted actions.** Appears only in `allRoles` — functionally identical to `member` in the backend policy table. |
| `treasury_steward` | **No restricted actions.** Despite the name, `reward_contribution` is ops-steward/founding-member only (roles.go:123). Functionally identical to `member`. |
| `founding_member` | Full admin bundle: member of every restricted scope. Also the role bundle granted to org-config admins and the backend's own identity (`rbac.go:119, 189`; `role_store.go:33`). |
| `elder_council` | **Ungrantable.** Present in `allRoles` (roles.go:103) but no `MapKERIRole` case, lookup, or endpoint ever assigns it. It exists **only in backend code** — the 2026-02-22 design doc's 10-role enum lists only the 10 KERI credential roles and never mentions it. (The governance "elders council" house at `contributions/models.go:210` / `service.go:1156-1160` is a separate veto mechanism, not this role.) |

Two policy entries are **dead**: `ActionApproveContribution` (roles.go:121) and `ActionCreateSubContrib` (roles.go:130) are defined in the table but no route is ever wrapped with them (grep confirms zero `RequireAction`/`withRBAC` uses across `internal/api/`).

### 2. KERI credential roles and the MapKERIRole table

The 10 valid membership-credential role strings are defined in `keri.ValidRoles()` (`backend/internal/keri/client.go:168-181`) and validated at credential store/role-update time via `IsValidRole` (`client.go:184-191`, used at `credentials.go:99→client.go:123` and `profiles.go:691`). `MapKERIRole` (`contributions/roles.go:23-48`) expands each into contribution roles:

| KERI credential role | Contribution roles granted |
|---|---|
| Member | member |
| Contributor | member, contributor |
| Community Steward | member, contributor, community_steward, **project_steward** |
| Operations Steward | member, contributor, operations_steward, project_steward, project_lead |
| Founding Member | member, contributor, founding_member, operations_steward, project_steward, project_lead |
| Financial Steward | member, contributor, treasury_steward |
| Governance Steward | member, contributor, community_steward |
| Treasury Steward | member, contributor, treasury_steward |
| Technical Steward | member, contributor, tech_steward, project_lead |
| Cultural Steward | member, contributor, community_steward |
| *(anything else)* | member (default case, roles.go:45-46) |

Notes: "Financial Steward" and "Treasury Steward" collapse to the same role; "Governance Steward" and "Cultural Steward" collapse into `community_steward`; stewards get `project_steward`/`project_lead` **globally**, not per-project. `elder_council` and `tech_steward`-with-powers have no source mapping that matters (see §1).

### 3. Request authentication & role resolution

Flow for an RBAC-wrapped endpoint (note: many mutating endpoints are **not** wrapped at all — see the Implementation Status table):

1. **`X-User-AID` header** — client-supplied, set by the frontend from its own identity store (`frontend/src/lib/api/client.ts:27-41` `authHeaders()`). No signature, no session token, no verification (`rbac.go:31`).
2. **`RBACMiddleware`** (`rbac.go:29-46`) — 401 if header absent; otherwise resolves roles via the injected `RoleLookup` and stores AID+roles in request context. On lookup *error* it proceeds with empty roles (fail-open into "no roles", rbac.go:37-40). `OptionalRBACMiddleware` (`rbac.go:78-93`) is the same but lets header-less requests through with no roles (used on read routes and on mixed read/write prefixes whose write subroutes then re-check in-handler, e.g. `decision_plans.go:28,39`, `proposals.go:54`).
3. **`RequireAction`** (`rbac.go:50-60`) — 403 unless `contributions.CanPerformAction(roles, action)` passes against the policy table.
4. Handlers may additionally call `GetUserAID(r)` / `GetUserRoles(r)` for in-handler checks (e.g. `proposals.go:209-210,226-227,260-261,402-403`, `contributions_handler.go:705,855,892,945`, `decision_plans.go:150-174`).

**The lookup chain** is assembled at `cmd/server/main.go:517-521` as `NewCompositeRoleLookup(profileRoleLookup, orgConfigRoleLookup, credentialRoleLookup, identityRoleLookup)`; the composite returns the first non-empty, non-error result (`rbac.go:204-215`). The four links:

- **`ProfileRoleLookup`** (`contributions/role_store.go:30-73`): (a) if the AID is in the org-config admin list (`SetAdminAIDs`, wired from org config with live updates at `main.go:526-539`) → `MapKERIRole("Founding Member")`; (b) else read `CommunityProfile`/`SharedProfile` objects from the community read-only space, match `userAID`/`aid`, map the `role` field; (c) else **default `[member]` for any non-empty AID** (role_store.go:70-72; also when the read-only space ID is empty, role_store.go:36-39).
- **`OrgConfigAdminLookup`** (`rbac.go:104-123`): org-config admins → Founding Member bundle.
- **`CredentialRoleLookup`** (`rbac.go:128-166`): scans cached credentials in anystore for `SubjectAID == aid` with a `role` field. Does **not** check the credential's `Verified`/issuer field.
- **`IdentityRoleLookup`** (`rbac.go:178-192`): if the AID equals the backend's own identity AID → Founding Member bundle (per-user architecture: the backend owner is admin).

**Dead fallbacks:** `ProfileRoleLookup.GetUserRoles` never returns an error and never returns an empty slice (worst case `[member]`), so in the production chain the composite **always stops at the first link** — `OrgConfigAdminLookup`, `CredentialRoleLookup`, and `IdentityRoleLookup` are unreachable at runtime (admin AIDs are still honored because they were also injected into `ProfileRoleLookup` via `SetAdminAIDs`).

### 4. How roles are granted and changed

- **Registration approval** (frontend-driven, steward UI): admin **first** calls `POST /api/v1/profiles/init-member` to create the member's `CommunityProfile` with `role: 'Member'` and `status: 'pending'` (`useAdminActions.ts:240-250` — profiles are created before the invite so they're synced when the member joins), **then** issues the membership credential via signify-ts (`useAdminActions.ts:320-343`), and finally updates the profile with the real credential SAID and flips it to approved (`useAdminActions.ts:355-380`). The backend endpoint takes the `role` verbatim from the request body (`profiles.go:452-459`, defaulting to "Member" at 412-414) and is registered with **no RBAC middleware and no X-User-AID requirement** (`profiles.go:974`); the frontend calls it without auth headers (`client.ts:447-451`).
- **Role change — `PUT /api/v1/members/{aid}/role`** (`HandleUpdateMemberRole`, `profiles.go:666-778`, routed at `profiles.go:975,980-983`): validates only that the role string is one of the 10 valid KERI roles (`profiles.go:691`), then updates the `CommunityProfile` `role` field. **There is no role check, no RBAC middleware, and not even an X-User-AID requirement** — any local caller can promote any AID to Founding Member. The frontend even calls it without auth headers (`client.ts:461-471`). UI gating: Dashboard shows "change role" only when `isSteward` (`pages/DashboardPage.vue:219` `canChangeRole`), and `ChangeRoleModal.vue:244` invokes it; steward *upgrades* additionally run multisig rotation + credential revoke/re-issue (`useAdminActions.ts:461-560`).
- **Member removal — `DELETE /api/v1/members/{aid}`** (`profiles.go:785-908`, routed `profiles.go:984-986`): same story — no backend auth; frontend gates with `isSteward` (`DashboardPage.vue:220`) and revokes the credential via KERIA (`useAdminActions.ts:851-904`).
- **Credential issuance/revocation** is done client-side via signify-ts against KERIA; the *real* enforcement there is cryptographic (you must control the org AID/registry), not backend RBAC. The backend's `POST /api/v1/credentials` store endpoint (`credentials.go:80-131`) is unauthenticated; it marks credentials `Verified` only if issuer == org AID (`credentials.go:116`), but `CredentialRoleLookup` ignores that flag (moot today only because that lookup is dead code, §3).

### 5. GetPermissionsForRole (KERI-level permission strings)

`backend/internal/keri/client.go:146-165` maps each KERI role to legacy permission strings:

| Role | Permissions |
|---|---|
| Member | read, comment |
| Contributor | read, comment, vote, contribute |
| Community Steward | read, comment, vote, propose, moderate, admin, issue_membership, approve_registrations |
| Operations Steward / Founding Member | read, comment, vote, propose, moderate, admin, issue_membership, revoke_membership, approve_registrations |
| Financial Steward | …base admin set… + manage_finances |
| Governance Steward | + manage_governance |
| Treasury Steward | + manage_treasury |
| Technical Steward | + manage_technical |
| Cultural Steward | + manage_cultural |
| *(unknown)* | read |

**It is decorative.** The only call site in the entire backend is `credentials.go:240` inside `HandleRoles` (`GET /api/v1/credentials/roles`, registered at `credentials.go:268`), an informational listing endpoint — and the frontend never calls that endpoint (zero hits for `credentials/roles` in `frontend/src/`). No enforcement path consults these strings. This matches the design intent of `docs/plans/2026-02-22-role-based-membership-design.md` ("permissions derived from role at runtime, not stored in credential", line 12) but the "runtime lookup" is never actually looked up.

### 6. Frontend role awareness

- **Admin state** is centralized in the identity store (`frontend/src/stores/identity.ts:42-55`): `isAdmin`, `adminCredential`, plus computed `isSteward` (role string contains "steward" or "founding member") and `canManageMembers` (contains "operations steward" or "founding member"). `checkAdminStatus()` (`identity.ts:225-337`) resolves admin-ness by three methods, in order: (1) any wallet credential whose role contains "steward"/"admin"/"founding"; (2) membership of the org group AID in KERIA (treated as "Community Steward"); (3) presence in the org-config admins list (treated as "Founding Member"). Result is cached once per session.
- **`useAdminAccess`** (`composables/useAdminAccess.ts:14-36`) is a thin wrapper re-exporting that store state (`isAdmin`, `canApproveRegistrations`, `isSteward`, `canManageMembers`).
- **Per-project role** is derived locally, not fetched: `pages/Projects/ProjectDetailPage.vue:682-696` maps KERI-admin → `'community_admin'`, else compares the user's AID against `project_lead_id`/`project_steward_id`, else `'member'`. That role string feeds `useProjectPermissions.ts` (whole file, lines 1-105; e.g. `canSignOffPlan = isAdmin || isSteward` at line 44) and `useContributionWorkflow.ts:8-13` role groups. The frontend's `community_admin` concept has **no backend counterpart** — the backend policy table has no such role; the closest is the Founding Member bundle.
- The frontend never queries the backend for the contribution-role list; the two vocabularies are kept in sync only by convention.

### Implementation Status

| Mechanism | Policy (roles.go) | Backend Enforcement | Frontend Gating | Level | Evidence |
|---|---|---|---|---|---|
| Identify caller (X-User-AID) | n/a | Header presence only; **no cryptographic verification**; LocalhostGuard (bundled mode only) | header auto-set from identity store | ⚠️ Policy not enforced | rbac.go:31-35, middleware.go:190-218, client.ts:27-41 |
| Role resolution (RBACMiddleware + RoleLookup chain) | mapping via MapKERIRole | Yes — profile-based lookup; org admins honored; defaults to `member` for any AID; 3 of 4 chain links unreachable | n/a | 🔷 Backend-only | rbac.go:29-46, role_store.go:30-73, main.go:517-539, rbac.go:204-215 |
| Action authorization (RequireAction) on wired routes: projects, milestones (archive/edit), contribution confirm/share/offer/accept-offer/submit-evidence/review/sign-off/reward/approve-sub/archive/unassign | per-action table, many `allRoles` | Yes on these routes | useProjectPermissions / useContributionWorkflow | ✅ Fully enforced (restricted actions on wired routes only) | rbac.go:50-60, projects.go:42-172, milestones.go:44-60, contributions_handler.go:112-185, 213-220 |
| Contribution create / assign / register-interest (POST /api/v1/contributions, /{id}/assign, /{id}/register) | ActionCreateContribution, ActionAssignContribution, ActionRegisterInterest — all `allRoles` | **None — routes bypass withRBAC entirely; no X-User-AID required** (Action constants exist but are never applied to these routes) | useProjectPermissions gates create/assign UI | ⚠️ Policy not enforced | contributions_handler.go:62-71, 91-97, 105-111; roles.go:118, 120, 132 |
| Contribution transition / update (POST /{id}/transition, PUT /{id}) | none (no Action constant) | **None** — handlers called directly; actor AID optional (header or body) | useContributionWorkflow status-transition matrix | 🔶 Frontend-only | contributions_handler.go:84-90, 202-210 |
| Plan sign-off — decision plans (status→signed_off) | ActionSignOffPlan (steward scope) | Yes — in-handler: `CanPerformAction(ActionSignOffPlan)` OR assigned proposal steward; 401 without header | `canSignOff` in DecisionPlanView / useProjectPermissions | ✅ Fully enforced | decision_plans.go:150-174, useProjectPermissions.ts:44 |
| Plan sign-off — implementation plans (POST /api/v1/implementation-plans/{id}/sign-off) | ActionSignOffPlan exists but is **not applied here** | **None — no role check; handler even accepts `user_id` from the request body**; handler registered without roleLookup | `canSignOffPlan` = isAdmin/isSteward | 🔶 Frontend-only | implementation_plans.go:36-60, 149-166, main.go:607, useProjectPermissions.ts:44 |
| Proposal sign-off/reject/edit/withdraw | roles.go:133-136 (steward scope) | Yes — in-handler `CanPerformAction` checks behind OptionalRBAC | `isAdmin` gates in proposal components | ✅ Fully enforced | proposals.go:54, 209-210, 226-227, 260-261, 402-403 |
| Change member role (PUT /api/v1/members/{aid}/role) | none (no Action constant) | **None — no RBAC, no X-User-AID required**; only `IsValidRole` string check | `canChangeRole` = `isSteward` on Dashboard; ChangeRoleModal | 🔶 Frontend-only | profiles.go:666-778, profiles.go:975,980-983, DashboardPage.vue:219, ChangeRoleModal.vue:244, client.ts:461-471 |
| Remove member (DELETE /api/v1/members/{aid}) | none | **None** | `canRemoveMember` = `isSteward` | 🔶 Frontend-only | profiles.go:785-908, profiles.go:984-986, DashboardPage.vue:220 |
| Create member profile with role (POST /api/v1/profiles/init-member) | none | **None** — role taken verbatim from request body | reachable only from steward approval flow (`isAdmin`-gated UI) | 🔶 Frontend-only | profiles.go:388-459, profiles.go:974, useAdminActions.ts:240-250 |
| Store credential (POST /api/v1/credentials) | none | Structure validation only; `Verified` flag set but never consulted by role lookup | none — no UI gate either | ⚠️ Policy not enforced (no check anywhere) | credentials.go:80-131, credentials.go:116, rbac.go:136-166 |
| Credential issuance/revocation (registration approve, steward upgrade, removal) | n/a | KERI cryptography via KERIA (must control org AID/registry) — outside backend RBAC | `isAdmin`/`isSteward` gates approval & upgrade UI | ✅ Fully enforced (by KERI, not RBAC) | useAdminActions.ts:320-343, 461-560, 851-904, identity.ts:225-337 |
| GetPermissionsForRole strings | n/a (parallel list) | Not consulted by any enforcement path; sole call site is informational GET /api/v1/credentials/roles | endpoint never called by frontend | ⚠️ Policy not enforced | keri/client.go:146-165, credentials.go:236-245 |
| `elder_council` role | in `allRoles` only | ungrantable — no mapping/endpoint assigns it; exists in code only, not in any design doc | n/a | ⚠️ Policy not enforced (code-only, unassignable) | roles.go:18, roles.go:103, roles.go:23-48 |
| `ActionApproveContribution` / `ActionCreateSubContrib` | roles.go:121, 130 (`allRoles`) | never wired to any route | n/a | ⚠️ Policy not enforced | roles.go:121, 130; no RequireAction/withRBAC call sites |

### Notes & Gaps

- **No authentication:** `X-User-AID` is a plain client-supplied header with zero verification (rbac.go:31). Security model = "local child process + LocalhostGuard in bundled mode" (middleware.go:190-218, main.go:761); in dev/test even the loopback restriction is off.
- **Privilege escalation via role-change endpoint:** `PUT /api/v1/members/{aid}/role` has no auth whatsoever — any local caller can set any member's role to "Founding Member" (profiles.go:666-778). The design doc (2026-02-22, line 70: "Only **Operations Steward** and **Founding Member** roles can update other members' roles") is enforced nowhere in the backend; the frontend gates with the *broader* `isSteward` (any steward), not `canManageMembers`, drifting even from its own spec (DashboardPage.vue:219).
- **Design-doc role update flow drifted:** the plan says the endpoint revokes the old credential and issues a new one (design doc lines 40, 48-51); the implementation only updates the CommunityProfile field (profiles.go:750-777). Credential revoke/re-issue happens only in the frontend steward-upgrade path (useAdminActions.ts:461-560), so profile role and credential role can diverge for non-steward changes.
- **Any AID is a member:** ProfileRoleLookup returns `[member]` for any unrecognized AID (role_store.go:70-72), and most actions are `allRoles` — so an invented AID string passes every `allRoles` RequireAction gate. The roles.go comment admits it: "project-level permission checks (lead, steward, admin) are enforced on the frontend" (roles.go:98-99).
- **Core contribution mutations skip RBAC entirely:** POST /api/v1/contributions (create), /{id}/assign, /{id}/register, /{id}/transition and PUT /{id} are registered without `withRBAC` (contributions_handler.go:62-71, 84-111, 202-210) — no X-User-AID is required at all, despite Action constants existing for create/assign/register-interest. The roles.go comment's claim that "Backend RBAC verifies the user is authenticated" (roles.go:98) is untrue for these routes.
- **Implementation-plan sign-off is unprotected:** POST /api/v1/implementation-plans/{id}/sign-off performs no role check and even accepts `user_id` from the request body when the header is absent (implementation_plans.go:149-166); the handler is registered without a roleLookup (main.go:607). `ActionSignOffPlan` is enforced only on the decision-plan path (decision_plans.go:150-174).
- **Three of four role lookups are dead code:** ProfileRoleLookup never errors and never returns empty, so OrgConfigAdminLookup, CredentialRoleLookup, and IdentityRoleLookup in the composite chain (main.go:521) can never be reached.
- **CredentialRoleLookup ignores verification:** it would accept any cached credential's role without checking issuer/`Verified` (rbac.go:144-164) — currently harmless only because the lookup is unreachable; a chain reorder would turn the unauthenticated `POST /api/v1/credentials` into direct role escalation.
- **tech_steward and treasury_steward are powerless:** they appear in no restricted action list — functionally identical to `member` in backend policy, despite their names and the KERI permission strings (manage_technical / manage_treasury) suggesting otherwise.
- **elder_council is ungrantable and undocumented:** no MapKERIRole case or endpoint assigns it, and — contrary to an earlier draft of this section — it does **not** appear in the 2026-02-22 design doc's 10-role enum (that enum lists the 10 KERI credential roles, Member through Cultural Steward). It is a code-only artifact (roles.go:18) reachable by nothing.
- **Design doc permission matrix is fiction relative to code:** `docs/design/PROJECTS_CONTRIBUTIONS_DOCUMENTATION.md` §6 claims Create Project is community_admin-only (line 916) and Register Interest is contributor/member-only (line 922); in code both are `allRoles` (roles.go:115, 132) — and Register Interest's route isn't even RBAC-wrapped. It also documents a 5-role model (`community_admin` etc., lines 905-909) that only exists in frontend TypeScript types (types/projects.ts:35-40), not in the backend.
- **Two role vocabularies + a third permission list coexist:** KERI credential roles (Title Case), contribution roles (snake_case), and GetPermissionsForRole strings — the last is entirely decorative (single informational call site, credentials.go:240; endpoint unused by frontend).
- **Frontend/backend admin notions differ:** frontend `isAdmin` accepts any credential whose role merely *contains* "steward"/"admin"/"founding" (identity.ts:250), and treats org-group-AID membership as admin (identity.ts:267-295, mapped to "Community Steward"); backend treats org-config admins / backend owner as Founding Member. Edge cases (e.g. Cultural Steward) are "admin" in the UI but only community_steward+project_steward in backend policy.

---

## Projects

The Projects area covers the project lifecycle: create, edit, delete, archive (cascading to plans/milestones/contributions), the completion workflow (submit → approve/reject), role assignment (project lead/steward), proposal linking, comments, and read visibility. Endpoints live in `backend/internal/api/projects.go` (`/api/v1/projects`, `/api/v1/projects/{id}`, and subroutes `assign-role`, `link-proposal`, `contributions`, `archive`, `submit-completion`, `approve-completion`, `reject-completion`, `comments`), registered with RBAC in `RegisterRoutes` (projects.go:39-182) via `RBACMiddleware` + `RequireAction` (rbac.go:29-60). The UI is `frontend/src/pages/ProjectsPage.vue` and `frontend/src/pages/Projects/ProjectDetailPage.vue`, gated by `useProjectPermissions.ts`.

Two systemic caveats frame everything below. First, authentication is a bare `X-User-AID` header with **no cryptographic verification** (rbac.go:31 — the middleware simply reads the header and looks up roles); any caller can present any AID. Second, `ProfileRoleLookup.GetUserRoles` defaults **any unrecognized AID to `member`** (role_store.go:70-72, and also when the read-only space is unconfigured, role_store.go:36-38), so every `allRoles` action is effectively open to anyone who sends any header value. Backend RBAC checks only **global** roles — there is no backend check that the caller is *this project's* lead or steward; per-project checks exist only in the frontend, which roles.go:98-99 admits by design ("project-level permission checks (lead, steward, admin) are enforced on the frontend").

### Permission Matrix

Columns are the contribution roles in `roles.go`. Cells reflect what the backend actually allows.

| Action | Member | Contributor | Project Lead | Project Steward | Ops Steward | Community Steward | Tech Steward | Treasury Steward | Founding Member | Elder Council⁷ |
|---|---|---|---|---|---|---|---|---|---|---|
| View / list projects | ✅¹ | ✅¹ | ✅¹ | ✅¹ | ✅¹ | ✅¹ | ✅¹ | ✅¹ | ✅¹ | ✅¹ |
| Create project | ✅² | ✅² | ✅² | ✅² | ✅² | ✅² | ✅² | ✅² | ✅² | ✅² |
| Edit project | ✅³ | ✅³ | ✅³ | ✅³ | ✅³ | ✅³ | ✅³ | ✅³ | ✅³ | ✅³ |
| Delete project | ✅⁴ | ✅⁴ | ✅⁴ | ✅⁴ | ✅⁴ | ✅⁴ | ✅⁴ | ✅⁴ | ✅⁴ | ✅⁴ |
| Archive project | ❌ | ❌ | ✅⁵ | ✅⁵ | ✅⁵ | ❌⁶ | ❌⁶ | ❌ | ✅⁵ | ❌ |
| Submit project completion | ❌ | ❌ | ✅⁵ | ❌ | ✅⁵ | ❌ | ❌⁶ | ❌ | ✅⁵ | ❌ |
| Approve project completion | ❌ | ❌ | ❌ | ✅⁵ | ✅⁵ | ❌⁶ | ❌ | ❌ | ✅⁵ | ❌ |
| Reject project completion | ❌ | ❌ | ❌ | ✅⁵ | ✅⁵ | ❌⁶ | ❌ | ❌ | ✅⁵ | ❌ |
| Assign project lead/steward | ✅² | ✅² | ✅² | ✅² | ✅² | ✅² | ✅² | ✅² | ✅² | ✅² |
| Link proposal to project | ✅¹ | ✅¹ | ✅¹ | ✅¹ | ✅¹ | ✅¹ | ✅¹ | ✅¹ | ✅¹ | ✅¹ |
| Read / add project comments | ✅¹ | ✅¹ | ✅¹ | ✅¹ | ✅¹ | ✅¹ | ✅¹ | ✅¹ | ✅¹ | ✅¹ |

¹ No backend check of any kind — no `X-User-AID` required. Open even to anonymous callers with network access to the backend port (projects.go:47/160-161 for GET; projects.go:80-86 for link-proposal; projects.go:146-155 for comments — the comment's `user_id`/`user_name` come from the request body, so authorship is caller-asserted).
² Policy is `allRoles` (roles.go:115). Because any AID resolves to at least `member` (role_store.go:72), this is effectively open to any caller who sends any `X-User-AID`. The UI shows the button only to admins ("New Project": ProjectsPage.vue:8; assign-role pencil: ProjectDetailPage.vue:49-92 via `canAssignRoles` = isAdmin), but that is cosmetic. Assign-role is gated with `ActionCreateProject`, not a dedicated action (projects.go:70).
³ Policy is `allRoles` (roles.go:116); same effective-open situation as ². UI shows Edit only to admin or project lead (ProjectDetailPage.vue:98, useProjectPermissions.ts:34).
⁴ Policy is `allRoles` (roles.go:117); same as ². No UI calls DELETE at all — the store's `remove()` (stores/projects.ts:186-196) has zero call sites; the "Delete Project" button in the UI actually calls the **archive** endpoint (ProjectDetailPage.vue:760-770 `confirmDestroy` → `projectsStore.archive`).
⁵ Global role only. The backend never verifies the caller is *this* project's lead/steward: `SubmitProjectCompletion`'s `leadID` parameter is entirely unused in the function body (service.go:2597-2627); `ApproveProjectCompletion` records `stewardID` as `CompletedBy` but performs no identity/role comparison (service.go:2630-2647); `RejectProjectCompletion` doesn't even receive the caller's AID (service.go:2650-2665). Any user holding the global role can act on **any** project, including approving a completion they themselves submitted.
⁶ Denied for the bare contribution role, but usually allowed in practice via KERI role mapping: KERI "Community Steward" also grants `project_steward` (roles.go:30) and KERI "Technical Steward" also grants `project_lead` (roles.go:42), which do satisfy these scopes.
⁷ `elder_council` is defined (roles.go:18) and included in `allRoles` (roles.go:100-104), but **no KERI role maps to it** (`MapKERIRole`, roles.go:23-48) — it is unreachable dead policy.

### Implementation Status

| Action | Policy (roles.go) | Backend Enforcement | Frontend Gating | Level | Evidence |
|---|---|---|---|---|---|
| create_project | allRoles | `RequireAction(ActionCreateProject)` wired, but policy admits every role and every AID resolves to ≥ member; no handler-internal check | `v-if="isAdmin"` on New Project button; `canCreateProject` = isAdmin | ⚠️ Policy not enforced (admin-only intent is frontend-only) | roles.go:115, projects.go:42, role_store.go:72, ProjectsPage.vue:8, useProjectPermissions.ts:32 |
| edit_project | allRoles | `RequireAction(ActionEditProject)` wired; policy admits every role; no handler check | Edit button `v-if="perms.canEditProject"` (admin or lead) | ⚠️ Policy not enforced (lead/admin intent is frontend-only) | roles.go:116, projects.go:163-169, ProjectDetailPage.vue:98, useProjectPermissions.ts:34 |
| delete_project | allRoles | `RequireAction(ActionDeleteProject)` wired; policy admits every role | None — no UI path calls DELETE (`remove()` unused; UI "Delete" archives instead) | ⚠️ Policy not enforced | roles.go:117, projects.go:170-177, stores/projects.ts:186-196, ProjectDetailPage.vue:760-770 |
| archive_project | restricted-to: project_lead, project_steward, operations_steward, founding_member | `RequireAction(ActionArchiveProject)` wired; global-role check only (no per-project lead/steward check in `ArchiveProject`) | ProjectForm `:can-delete="perms.canArchiveProject"` → ConfirmDestroyDialog → archive | ✅ Fully enforced (global scope; per-project scoping frontend-only) | roles.go:110-112,137, projects.go:94-105, service.go:2066, ProjectDetailPage.vue:362,760-770, useProjectPermissions.ts:52 |
| submit_project_completion | restricted-to: project_lead, operations_steward, founding_member | `RequireAction` wired; service validates status + all contributions signed off, but the `leadID` argument is never used — no check that the caller is the project's lead | `:can-submit="perms.canSubmitProjectCompletion"` (admin or lead) | ✅ Fully enforced (global scope; project-lead binding not enforced) | roles.go:142, projects.go:107-119, service.go:2597-2627, ProjectDetailPage.vue:133, useProjectPermissions.ts:57 |
| approve_project_completion | restricted-to: project_steward, operations_steward, founding_member | `RequireAction` wired; handler additionally requires non-empty AID; no per-project steward check, no submitter≠approver check | `:can-approve="perms.canApproveProjectCompletion"`; Approve button under `v-if="canApprove"` | ✅ Fully enforced (global scope) | roles.go:106-108,143, projects.go:120-131,389-395, service.go:2630-2647, ProjectDetailPage.vue:134, ProjectCompletionSection.vue:26-36 |
| reject_project_completion | restricted-to: project_steward, operations_steward, founding_member | `RequireAction` wired; caller identity not passed to service (rejection is anonymous in data) | "Send Back" button gated by `canApprove` (the dedicated `canRejectProjectCompletion` computed is exported but never used in any component) | ✅ Fully enforced (global scope) | roles.go:144, projects.go:133-145, service.go:2650-2665, ProjectCompletionSection.vue:26-44, useProjectPermissions.ts:59 |
| assign project lead/steward (`assign-role`) | none — reuses ActionCreateProject (allRoles) | RBAC wired but with the create_project action → effectively any AID | Pencil/assign buttons `v-if="perms.canAssignRoles"` (admin only) | ⚠️ Policy not enforced (admin-only intent is frontend-only; no dedicated action constant) | projects.go:66-79, roles.go:115, ProjectDetailPage.vue:49-92, useProjectPermissions.ts:38 |
| link-proposal | none — no action constant | None — route registered with no RBAC middleware; no header required | Reachable via edit dialog (admin/lead) | 🔶 Frontend-only | projects.go:80-86, ProjectDetailPage.vue:355-366, lib/api/projects.ts:123 |
| list / view projects (GET list, GET by id, GET {id}/contributions) | none | None — handlers registered outside RBAC; no `X-User-AID` needed; full project data incl. budget fields returned to anyone | None — all logged-in users see the Projects page; "My Projects" is a display filter only | ⚠️ Policy not enforced (fully open, incl. anonymous) | projects.go:45-54,87-93,159-161, ProjectsPage.vue:17-53 |
| project comments (GET/POST {id}/comments) | none | None — no RBAC; POST takes `user_id`/`user_name` from request body (caller-asserted authorship) | Comment box shown to any user viewing the project | ⚠️ Policy not enforced | projects.go:146-155,432-465 |

### Notes & Gaps

- **`X-User-AID` is unauthenticated.** `RBACMiddleware` trusts the header verbatim (rbac.go:31) — there is no signature or KERI proof. Combined with `ProfileRoleLookup` defaulting any unknown AID to `member` (role_store.go:70-72), every `allRoles` action (create/edit/delete project, assign-role) is open to any caller who invents a header. Spoofing a known admin AID grants Founding Member roles (rbac.go:112-123, role_store.go:31-33).
- **Design-doc drift on Create Project.** `docs/design/PROJECTS_CONTRIBUTIONS_DOCUMENTATION.md` §6.2 says Create Project = Community Admin only (all other roles ❌); the code policy is `allRoles` (roles.go:115). The admin restriction exists only as a UI `v-if` (ProjectsPage.vue:8). The doc's 5-role model (§6.1) also doesn't match the 10-role code model. `docs/plans/2026-02-22-role-based-membership-design.md` contains no project-action content at all.
- **Backend RBAC is global-role, not per-project.** The comment at roles.go:98-99 documents this as intentional: "project-level permission checks (lead, steward, admin) are enforced on the frontend." E.g. any Technical Steward (global `project_lead`) can archive or submit completion on any project; any project steward can approve any project's completion, including one they submitted.
- **`SubmitProjectCompletion`'s `leadID` parameter is dead** (service.go:2597-2627) — accepted from `GetUserAID` (projects.go:377) but never compared to `proj.ProjectLeadID` nor stored. `RejectProjectCompletion` never learns who rejected (service.go:2650).
- **DELETE endpoint is live but orphaned.** No UI calls it (stores/projects.ts:186 `remove` has no call sites); the visible "Delete Project" flow actually archives (ProjectDetailPage.vue:760-770). Meanwhile `DELETE /api/v1/projects/{id}` remains callable by any member-role AID (roles.go:117).
- **Read visibility is completely open.** GET list/get/contributions/comments require no header at all — anyone who can reach the backend port sees all projects (including budget/rejection-reason fields). The "My Projects" section on ProjectsPage is a cosmetic filter, not access control.
- **`assign-role` has no dedicated Action** — it piggybacks on `ActionCreateProject` (projects.go:70), so the effective policy is `allRoles`; only the frontend limits it to admins.
- **`link-proposal` has zero backend checks** (projects.go:80-86) — not even the RBAC middleware.
- **`elder_council` is dead policy** — defined and included in `allRoles` (roles.go:18,100-104) but `MapKERIRole` never emits it (roles.go:23-48).
- **`GetPermissionsForRole` (keri/client.go:146-165) is decorative** for enforcement: its only call site is the informational `GET /api/v1/credentials/roles` response (credentials.go:240). It is a parallel permission vocabulary ("read", "moderate", "admin", …) never consulted by RBAC middleware or handlers.
- **Frontend dead code:** `canRejectProjectCompletion` (useProjectPermissions.ts:59) is exported but unused — the Send Back button is gated by `canApprove` (ProjectCompletionSection.vue:26-44). `canDeleteProject` (useProjectPermissions.ts:36) is likewise unused.
- **Frontend admin detection differs from backend's:** the UI's `identityStore.isAdmin` derives from KERI credentials/org-group membership/config admins (stores/identity.ts:225-337), while backend role lookup chains profile → org-config admins → cached credentials → own-identity (cmd/server/main.go:517-521); the two can disagree (e.g. UI hides buttons the backend would allow, and vice versa).

---

## Contributions Lifecycle

This area covers the full contribution workflow: create (parent and sub-contribution), confirm, share, offer, register interest, accept offer, assign/unassign, submit evidence, review, approve sub-contribution, sign off (contribution and the prerequisite implementation-plan sign-off), reward, archive, plus comments, budget visibility, and list/offer visibility. Endpoints live in `backend/internal/api/contributions_handler.go` (all under `/api/v1/contributions[...]`) and `backend/internal/api/implementation_plans.go` (plan sign-off). The policy table is `actionPermissions` in `backend/internal/contributions/roles.go:114-145`; enforcement plumbing is `RBACMiddleware`/`RequireAction` in `backend/internal/api/rbac.go:29-60`, applied per-route via `withRBAC` (`contributions_handler.go:215-220`). Frontend gating lives in `useContributionWorkflow.ts`, `useProjectPermissions.ts`, `useContributionBudgetAccess.ts`, `useAdminAccess.ts`, and computed guards in `ContributionDetailBody.vue` (in `components/contributions/`, not `pages/Contributions/`) / `ContributionDetailPage.vue` / `ContributionsPage.vue`, with list visibility in `lib/contributionsView.ts`.

Two cross-cutting facts shape everything below. First, identity is the `X-User-AID` header read verbatim at `rbac.go:31` — there is **no cryptographic verification**; any caller who can reach the API can impersonate any AID, so even "fully enforced" rows are spoofable. Second, `roles.go:98-99` states the design intent openly: *"Backend RBAC verifies the user is authenticated; project-level permission checks (lead, steward, admin) are enforced on the frontend."* Most wired actions map to `allRoles`, meaning the backend check degrades to "caller's AID resolves to at least one community role." A further systemic bypass: `POST /api/v1/contributions/{id}/transition` performs arbitrary status transitions with **no RBAC at all** (`contributions_handler.go:84-90`), constrained only by the status machine — it can move a contribution to `signed_off` or `rewarded` without the role checks the dedicated endpoints impose.

### Permission Matrix

Columns are the contribution-system roles from `roles.go:8-19`. A user's single KERI credential grants a bundle of these via `MapKERIRole` (`roles.go:23-48`) — e.g. the "Community Steward" credential grants member+contributor+community_steward+project_steward. The matrix reflects what the **backend** actually allows a caller holding that role.

| Action | Member | Contributor | Project Lead | Project Steward | Ops Steward | Community Steward | Tech Steward | Treasury Steward | Founding Member | Elder Council |
|---|---|---|---|---|---|---|---|---|---|---|
| View list / detail / registrations (incl. unshared, budget, evidence, interest statements) | ✅⁰ | ✅⁰ | ✅⁰ | ✅⁰ | ✅⁰ | ✅⁰ | ✅⁰ | ✅⁰ | ✅⁰ | ✅⁰ |
| Create contribution (parent) | ✅⁰ | ✅⁰ | ✅⁰ | ✅⁰ | ✅⁰ | ✅⁰ | ✅⁰ | ✅⁰ | ✅⁰ | ✅⁰ |
| Create sub-contribution | ✅⁰ | ✅⁰ | ✅⁰ | ✅⁰ | ✅⁰ | ✅⁰ | ✅⁰ | ✅⁰ | ✅⁰ | ✅⁰ |
| Edit contribution (PUT) | ✅⁰ | ✅⁰ | ✅⁰ | ✅⁰ | ✅⁰ | ✅⁰ | ✅⁰ | ✅⁰ | ✅⁰ | ✅⁰ |
| Raw status transition (`/transition`) | ✅⁰ | ✅⁰ | ✅⁰ | ✅⁰ | ✅⁰ | ✅⁰ | ✅⁰ | ✅⁰ | ✅⁰ | ✅⁰ |
| Assign contributor (`/assign`) | ✅⁰ | ✅⁰ | ✅⁰ | ✅⁰ | ✅⁰ | ✅⁰ | ✅⁰ | ✅⁰ | ✅⁰ | ✅⁰ |
| Register interest | ✅⁰ᵃ | ✅⁰ᵃ | ✅⁰ᵃ | ✅⁰ᵃ | ✅⁰ᵃ | ✅⁰ᵃ | ✅⁰ᵃ | ✅⁰ᵃ | ✅⁰ᵃ | ✅⁰ᵃ |
| Add / list comments | ✅⁰ | ✅⁰ | ✅⁰ | ✅⁰ | ✅⁰ | ✅⁰ | ✅⁰ | ✅⁰ | ✅⁰ | ✅⁰ |
| Confirm | ✅¹ | ✅¹ | ✅¹ | ✅¹ | ✅¹ | ✅¹ | ✅¹ | ✅¹ | ✅¹ | ✅¹ |
| Share | ✅¹ | ✅¹ | ✅¹ | ✅¹ | ✅¹ | ✅¹ | ✅¹ | ✅¹ | ✅¹ | ✅¹ |
| Offer | ✅¹ | ✅¹ | ✅¹ | ✅¹ | ✅¹ | ✅¹ | ✅¹ | ✅¹ | ✅¹ | ✅¹ |
| Accept offer | ✅² | ✅² | ✅² | ✅² | ✅² | ✅² | ✅² | ✅² | ✅² | ✅² |
| Submit evidence | ✅¹ᵇ | ✅¹ᵇ | ✅¹ᵇ | ✅¹ᵇ | ✅¹ᵇ | ✅¹ᵇ | ✅¹ᵇ | ✅¹ᵇ | ✅¹ᵇ | ✅¹ᵇ |
| Review (approve/incomplete/decline) | ✅¹ | ✅¹ | ✅¹ | ✅¹ | ✅¹ | ✅¹ | ✅¹ | ✅¹ | ✅¹ | ✅¹ |
| Approve sub-contribution | ✅¹ | ✅¹ | ✅¹ | ✅¹ | ✅¹ | ✅¹ | ✅¹ | ✅¹ | ✅¹ | ✅¹ |
| Sign off contribution | ❌³ | ❌³ | ❌³ | ✅ | ✅ | ❌³ | ❌³ | ❌³ | ✅ | ❌³ |
| Sign off implementation plan | ✅⁴ | ✅⁴ | ✅⁴ | ✅⁴ | ✅⁴ | ✅⁴ | ✅⁴ | ✅⁴ | ✅⁴ | ✅⁴ |
| Reward | ❌³ | ❌³ | ❌³ | ❌³ | ✅ | ❌³ | ❌³ | ❌³ | ✅ | ❌³ |
| Archive contribution | ❌³ | ❌³ | ✅ | ✅ | ✅ | ❌³ | ❌³ | ❌³ | ✅ | ❌³ |
| Unassign contributor | ❌³ | ❌³ | ✅ | ✅ | ✅ | ❌³ | ❌³ | ❌³ | ✅ | ❌³ |
| See budget field via API | ✅⁰ | ✅⁰ | ✅⁰ | ✅⁰ | ✅⁰ | ✅⁰ | ✅⁰ | ✅⁰ | ✅⁰ | ✅⁰ |

⁰ **No backend auth or role check at all** — the route is registered without any RBAC middleware; even the `X-User-AID` header is optional. UI gating (see Implementation Status) is the only restriction.
¹ Wired through `RequireAction`, but the policy entry is `allRoles` (`roles.go:114-145`) — any AID that resolves to ≥1 community role passes; the role matrix shown in the UI is not checked by the backend.
² `allRoles` at the role layer, but the service enforces identity: for `offered` contributions the caller's AID must equal `offered_to` (`service.go:1726-1728`); anyone may accept a `shared` contribution (`service.go:1729-1730`).
³ Denied only if the caller holds *none* of the allowed roles; note the raw `/transition` endpoint (row above) performs the same status change with no role check, so these ❌ are bypassable.
⁴ Policy entry `ActionSignOffPlan` is restricted to steward scope (`roles.go:129`) but the route is **not wired** through RBAC — the handler even accepts `user_id` from the request body (`implementation_plans.go:149-163`).
ᵃ Service requires the contribution to be in `shared` status (`service.go:1525-1527`); no role/identity check — `user_id` can come from the request body (`contributions_handler.go:470-472`).
ᵇ Backend requires status `assigned` and all children signed off (`service.go:1760-1779`) but does **not** verify the caller is the assigned contributor.

### Implementation Status

| Action | Policy (roles.go) | Backend Enforcement | Frontend Gating | Level | Evidence |
|---|---|---|---|---|---|
| Create contribution (parent) | `ActionCreateContribution`: allRoles — **not wired** | none (route registered without RBAC) | ContributionsPage create button admin-only; MilestoneCard `canEdit`; `useProjectPermissions.canCreateContribution` (admin/lead/steward) | 🔶 Frontend-only | contributions_handler.go:62-71; roles.go:118; ContributionsPage.vue:9; useProjectPermissions.ts:46-48 |
| Create sub-contribution | `ActionCreateSubContrib`: allRoles — **not wired** | none (same POST endpoint, `parent_contribution` in body) | `canAddSubContribution` (assignee or lead/steward/admin, non-terminal status, no nesting) | 🔶 Frontend-only | contributions_handler.go:62-71; roles.go:130; service.go:1340-1350; useContributionWorkflow.ts:164-176 |
| Edit contribution (PUT) | no Action constant | none | `canEditContribution` (lead/steward/admin, not terminal status); change-request flow additionally gated by `canChange` (assignee or lead/steward/admin, status assigned) | 🔶 Frontend-only | contributions_handler.go:202-209, 335-454; ContributionDetailBody.vue:1283-1287, 1280-1282; ContributionDetailPage.vue:320-325; useContributionWorkflow.ts:195-205 |
| Confirm | `ActionConfirmContribution`: allRoles | `RequireAction` wired, but allRoles → auth-only; service requires deadline + created/changed status | `canConfirm` (steward/admin + deadline) | ⚠️ Policy not enforced | contributions_handler.go:112-118; roles.go:119; service.go:1633-1666; useContributionWorkflow.ts:28-38 |
| Share | `ActionShareContribution`: allRoles | wired, allRoles → auth-only; service requires confirmed status | `canShare` (lead/steward/admin + plan signed off) | ⚠️ Policy not enforced | contributions_handler.go:119-125; roles.go:124; service.go:1670-1689; useContributionWorkflow.ts:60-70 |
| Offer | `ActionOfferContribution`: allRoles | wired, allRoles → auth-only; service requires confirmed/shared/offered status | `canOffer` (lead/steward/admin + plan signed off) | ⚠️ Policy not enforced | contributions_handler.go:126-132; roles.go:125; service.go:1694-1714; useContributionWorkflow.ts:78-90 |
| Register interest | `ActionRegisterInterest`: allRoles — **not wired** | none (`user_id` accepted from body); service requires shared status | `canRegisterInterest` (contributor/member, shared, not assignee, not already registered) | 🔶 Frontend-only | contributions_handler.go:91-97, 458-533; roles.go:132; service.go:1520-1539; useContributionWorkflow.ts:96-110 |
| Accept offer | `ActionAcceptOffer`: allRoles | wired + **service-level identity check**: caller must equal `offered_to` (shared → anyone); handler takes caller AID from RBAC context | `canAccept` (`offered_to === currentUserId`) | ✅ Fully enforced | contributions_handler.go:133-139, 699-737; roles.go:126; service.go:1719-1751; useContributionWorkflow.ts:115-119 |
| Assign (direct `/assign`) | `ActionAssignContribution`: allRoles — **not wired** | none; service requires confirmed/shared status | assignment/reassignment UI only exposed to lead/steward/admin (`canReassignContribution`, `canOfferToContributor`) | 🔶 Frontend-only | contributions_handler.go:105-111, 547-583; roles.go:120; service.go:1592-1610; ContributionDetailBody.vue:1270-1279, 1288 |
| Unassign | `ActionUnassignContribution`: lead+steward+ops+founding | `RequireAction` with restricted scope; service requires status assigned | `canUnassignNow` (lead/steward/admin, status assigned) | ✅ Fully enforced¹ | contributions_handler.go:182-188; roles.go:110-112,140; service.go:2493-2510; ContributionDetailBody.vue:1276-1279 |
| Submit evidence | `ActionSubmitEvidence`: allRoles | wired, allRoles → auth-only; service checks status + children signed off but **not** that caller is the assignee | `canSubmitEvidence` (assignee or lead/steward/admin + children done) | ⚠️ Policy not enforced | contributions_handler.go:140-146; roles.go:127; service.go:1755-1815; useContributionWorkflow.ts:127-140 |
| Review | `ActionReviewContribution`: allRoles | wired, allRoles → auth-only; service requires needs_review status | `canReview` (lead/admin) | ⚠️ Policy not enforced | contributions_handler.go:147-153; roles.go:128; service.go:1845-1883; useContributionWorkflow.ts:145-150 |
| Approve sub-contribution | `ActionApproveSubContrib`: allRoles | wired, allRoles → auth-only; service requires parent link + created/changed | composable `canApproveSub` (lead/admin) — but ContributionDetailBody uses its own lead-or-steward check (both include admin) | ⚠️ Policy not enforced | contributions_handler.go:168-174; roles.go:131; service.go:1954-1974; useContributionWorkflow.ts:183-187; ContributionDetailBody.vue:1264 |
| Sign off contribution | `ActionSignOffContribution`: project_steward+ops+founding | `RequireAction` restricted + service requires approved status and signed-off plan | `canSignOff` (steward/admin) | ✅ Fully enforced¹ | contributions_handler.go:154-160; roles.go:122; service.go:1886-1923; useContributionWorkflow.ts:155-157 |
| Sign off implementation plan | `ActionSignOffPlan`: steward scope — **not wired on route** | none — no RBAC middleware; accepts `user_id` from body | `canSignOffPlan` (steward/admin) | ⚠️ Policy not enforced | implementation_plans.go:60-63, 149-163; roles.go:129; useContributionWorkflow.ts:217-219; useProjectPermissions.ts:44 |
| Reward | `ActionRewardContribution`: ops+founding only | `RequireAction` restricted + service requires signed_off status | `canRewardNow` (community_admin only, signed_off) | ✅ Fully enforced¹ | contributions_handler.go:161-167; roles.go:123; service.go:1928-1948; ContributionDetailBody.vue:1257-1260 |
| Archive | `ActionArchiveContribution`: lead+steward+ops+founding | `RequireAction` restricted; service cascades archive to children and unsigns the plan | `can-archive="canEditContribution"` (lead/steward/admin) | ✅ Fully enforced¹ | contributions_handler.go:175-181; roles.go:139; service.go:2432-2489; ContributionDetailPage.vue:23, 320-325 |
| Raw status transition (`/transition`) | no Action constant | **none** — arbitrary transitions, only status-machine + child-completion validation | no UI exposes raw transitions (workflow buttons use dedicated endpoints) | ⚠️ Policy not enforced (API backdoor) | contributions_handler.go:84-90, 263-332; service.go:1486-1516; validation.go:68 |
| Add/list comments | no Action constant | none; `user_id`/`user_name` taken from body (spoofable attribution) | comment box shown to all signed-in users | ⚠️ Policy not enforced (open by design) | contributions_handler.go:189-198, 1021-1068 |
| View list/detail/registrations (visibility) | no Action constant | none — GET endpoints (list, detail, `/registrations`) return every contribution incl. unshared, budgets, evidence, and interest-registration statements; no auth header required | list view hides other users' private offers from non-admins and hides `confirmed` from All view; "Mine" scope filter | 🔶 Frontend-only | contributions_handler.go:62-65, 98-104, 202-204, 241-260, 536-544; contributionsView.ts:75-119; ContributionsPage.vue:239-248 |
| See budget field | no Action constant | none — budget always serialized in API responses | `useContributionBudgetAccess.canSeeBudget` (admin or project lead/steward); `useProjectPermissions.canSeeContributionBudget` | 🔶 Frontend-only | useContributionBudgetAccess.ts:14-21; useProjectPermissions.ts:75-77; contributions_handler.go:252-260 |
| Shared-with-roles targeting | no Action constant | none — `shared_with_roles` stored and echoed, never used as a filter | none — displayed as informational text only; not used in any visibility filter | 📄 Documented only (as access control) | service.go:1681-1683; ContributionDetailBody.vue:105-106; contributionsView.ts (no reference); PROJECTS_CONTRIBUTIONS_DOCUMENTATION.md §7.1 |

¹ "Fully enforced" at the role layer, but bypassable two ways: the unauthenticated `X-User-AID` header (`rbac.go:31`), and the ungated `/transition` endpoint which can produce the same status change without the role check.

### Notes & Gaps

- **`X-User-AID` is unverified.** `RBACMiddleware` trusts the header verbatim (`rbac.go:29-46`); there is no signature or KERI-based proof binding the request to the AID. Every backend check in this section is impersonatable by anyone with network access to the backend port.
- **`POST /contributions/{id}/transition` is a full RBAC bypass** — no middleware, no role check (`contributions_handler.go:84-90`). It can drive a contribution to `signed_off` or `rewarded`, statuses whose dedicated endpoints are the only ones with real role restrictions. Only `ValidateContributionTransition` (status machine, `validation.go:68`) and child-completion checks apply.
- **Plan sign-off is not wired through RBAC** despite a restricted `ActionSignOffPlan` policy entry (`roles.go:129`). The handler comment admits it ("no RBAC middleware on this route", `implementation_plans.go:152`) and it accepts `user_id` from the request body (`implementation_plans.go:149-163`). Since contribution sign-off requires a signed-off plan (`service.go:1898-1912`), the sign-off chain's first gate is frontend-only.
- **Create/edit/assign/register/comments/registrations endpoints have no backend role check at all**, and `POST /api/v1/contributions` requires no header whatsoever — this differs from `POST /api/v1/projects`, which is wired through `RBACMiddleware`+`RequireAction` (`projects.go:42`), though even there the `ActionCreateProject` policy entry is `allRoles`, so the projects gate only requires a resolvable role. Action constants `ActionCreateContribution`, `ActionCreateSubContrib`, `ActionAssignContribution`, `ActionRegisterInterest` exist in the policy table but are never wired to a route.
- **Most wired actions are `allRoles`** (confirm, share, offer, accept-offer, submit-evidence, review, approve-sub), so the backend check reduces to "AID resolves to ≥1 role." The comment at `roles.go:98-99` documents this as intentional: project-level checks are delegated to the frontend.
- **Backend role checks are community-global, not project-scoped.** `RequireAction` checks the caller's mapped roles only; per-project `project_lead_id` / `project_steward_id` matching happens exclusively in the frontend (`ContributionDetailPage.vue:310-318`, `useProjectPermissions.ts:16-30`). Any project_steward-role holder can sign off any project's contributions via the API.
- **Submit-evidence does not verify the assignee** (`service.go:1755-1815`): any recognized member can submit evidence on someone else's assigned contribution; the assignee identity check exists only in `canSubmitEvidence` (frontend).
- **`shared_with_roles` is decorative.** It is stored (`service.go:1681-1683`) and displayed, but no backend or frontend code filters visibility by it. Design doc §7.1 claims "Members in those roles can now see and register interest" — not implemented; all contributions are visible to everyone via the API, and `RegisterInterest` checks only `status == shared`.
- **Budget confidentiality and admin-only offer visibility are cosmetic**: `useContributionBudgetAccess` and the `viewerIsAdmin` list filter (`contributionsView.ts:90-103`) run client-side against full data already delivered by unauthenticated GET endpoints.
- **`elder_council` is unreachable**: `RoleElderCouncil` is defined (`roles.go:18`) and included in `allRoles`, but no branch of `MapKERIRole` (`roles.go:23-48`) ever grants it.
- **Two frontend role models coexist**: the backend's 10-role model vs. the UI's `community_admin`/`project_lead`/`project_steward`/`contributor`/`member` (`ContributionDetailPage.vue:291-296` collapses everything else to `member`). A backend-privileged user (e.g. Community Steward credential → project_steward role) who is not the project's steward sees a `member` UI but passes backend checks.
- **Frontend-internal drift on approve-sub**: `useContributionWorkflow.canApproveSub` allows lead/admin only (ts:183-187), while `ContributionDetailBody.vue:1264` uses `isLead || isSteward` (lead/steward/admin).
- **Design doc §6 (PROJECTS_CONTRIBUTIONS_DOCUMENTATION.md:899-961) has drifted**: it claims Register Interest is denied to admins/leads/stewards (code merely requires shared status; frontend hides it from privileged roles but backend allows anyone), claims Submit Evidence is assignee-only (backend doesn't check; frontend also allows lead/steward/admin per useContributionWorkflow.ts:127-140), claims Create Contribution is admin+lead only (ContributionsPage button is admin-only; useProjectPermissions allows admin/lead/steward; backend allows anyone), and presents its matrix as enforced access control when most of it is UI-layer only. Reward, archive, unassign, and the `/transition` backdoor are absent from the doc's matrix entirely.
- **`GetPermissionsForRole` (keri/client.go:146-165) is decorative for this area**: its only call site is `GET /api/v1/credentials/roles` (credentials.go:240), which returns the strings for display; nothing in the contributions path consults these permission strings.

---

## Plans, Milestones & Governance Actions

This area covers **implementation plans** (per-project work plans containing milestones, with a sign-off lifecycle and a "redline" change log), **milestones** (create/edit/set-dates/archive), **decision plans** (per-proposal governance plans), and **governance actions** (meetings, discussions, and house decisions with voting). Backend endpoints live in `backend/internal/api/implementation_plans.go`, `milestones.go`, and `decision_plans.go`; the policy table is `actionPermissions` in `backend/internal/contributions/roles.go`. The UI surface is `frontend/src/pages/Projects/ProjectDetailPage.vue` (plan tab, milestone dialogs, redline view) and `frontend/src/pages/ProposalDetailPage.vue` + `components/proposals/DecisionPlanView.vue` / `GovernanceActionModal.vue` (decision plans and voting).

Enforcement is highly uneven. Only the two standalone milestone endpoints (`PUT /api/v1/milestones/{id}`, `POST /api/v1/milestones/{id}/archive`) are wired through `RBACMiddleware` + `RequireAction` (milestones.go:44, milestones.go:60). The entire implementation-plans handler is registered **without any RBAC middleware** (cmd/server/main.go:607 — `implPlansHandler.RegisterRoutes(mux)`, no roleLookup), so plan create/read/add-milestone/**sign-off** require no role and, for sign-off, not even a verified caller. Decision plans use `OptionalRBACMiddleware` with a single in-handler check on the sign-off transition (decision_plans.go:150-174); governance-action endpoints (`complete`/`archive`/`vote`/`resolve`) have **no middleware and no role checks at all** (decision_plans.go:68-94). All identity comes from the unverified `X-User-AID` header (rbac.go:31); roles.go:98-99 states outright: *"Backend RBAC verifies the user is authenticated; project-level permission checks (lead, steward, admin) are enforced on the frontend."*

### Permission Matrix

| Action | Member | Contributor | Project Lead | Project Steward | Ops Steward | Community Steward | Tech Steward | Treasury Steward | Founding Member | Elder Council |
|---|---|---|---|---|---|---|---|---|---|---|
| View implementation plans / redline change log | ✅⁵ | ✅⁵ | ✅⁵ | ✅⁵ | ✅⁵ | ✅⁵ | ✅⁵ | ✅⁵ | ✅⁵ | ✅⁵ |
| Create implementation plan | ✅¹ | ✅¹ | ✅¹ | ✅¹ | ✅¹ | ✅¹ | ✅¹ | ✅¹ | ✅¹ | ✅¹ |
| Add milestone to plan | ✅¹ | ✅¹ | ✅¹ | ✅¹ | ✅¹ | ✅¹ | ✅¹ | ✅¹ | ✅¹ | ✅¹ |
| Edit milestone (incl. set start/end dates, budget, status) | ❌ | ❌ | ✅ | ✅ | ✅ | ❌² | ❌² | ❌ | ✅ | ❌ |
| Archive milestone | ❌ | ❌ | ✅ | ✅ | ✅ | ❌² | ❌² | ❌ | ✅ | ❌ |
| Sign off implementation plan | ✅³ | ✅³ | ✅³ | ✅³ | ✅³ | ✅³ | ✅³ | ✅³ | ✅³ | ✅³ |
| View decision plans | ✅⁵ | ✅⁵ | ✅⁵ | ✅⁵ | ✅⁵ | ✅⁵ | ✅⁵ | ✅⁵ | ✅⁵ | ✅⁵ |
| Create decision plan | ✅¹ | ✅¹ | ✅¹ | ✅¹ | ✅¹ | ✅¹ | ✅¹ | ✅¹ | ✅¹ | ✅¹ |
| Submit decision plan for review (transition drafted→submitted) | ✅¹ | ✅¹ | ✅¹ | ✅¹ | ✅¹ | ✅¹ | ✅¹ | ✅¹ | ✅¹ | ✅¹ |
| Sign off decision plan (transition→signed_off) | ❌⁴ | ❌⁴ | ❌⁴ | ✅ | ✅ | ❌² ⁴ | ❌⁴ | ❌⁴ | ✅ | ❌⁴ |
| Add governance action | ✅¹ | ✅¹ | ✅¹ | ✅¹ | ✅¹ | ✅¹ | ✅¹ | ✅¹ | ✅¹ | ✅¹ |
| Complete governance action (meeting/discussion) | ✅¹ | ✅¹ | ✅¹ | ✅¹ | ✅¹ | ✅¹ | ✅¹ | ✅¹ | ✅¹ | ✅¹ |
| Archive governance action | ✅¹ | ✅¹ | ✅¹ | ✅¹ | ✅¹ | ✅¹ | ✅¹ | ✅¹ | ✅¹ | ✅¹ |
| Cast vote on a decision action (any house, incl. Elder Council veto) | ✅⁶ | ✅⁶ | ✅⁶ | ✅⁶ | ✅⁶ | ✅⁶ | ✅⁶ | ✅⁶ | ✅⁶ | ✅⁶ |
| Resolve decision (close voting, tally) | ✅¹ | ✅¹ | ✅¹ | ✅¹ | ✅¹ | ✅¹ | ✅¹ | ✅¹ | ✅¹ | ✅¹ |

¹ No backend role check — anyone who can reach the API can call it (implementation-plans routes don't even require `X-User-AID`). The UI hides the button from non-privileged users, but that is the only gate.
² The contribution-role itself is excluded, but the KERI **credential** "Community Steward" also grants `project_steward` and "Technical Steward" grants `project_lead` (roles.go:30, roles.go:42), so holders of those credentials pass the backend check anyway. The same mapping applies to decision-plan sign-off: a Community Steward credential passes via `project_steward` (a Technical Steward credential does not, since `project_lead` is not in the `sign_off_plan` set). Enforcement is global, not per-project: any user with a qualifying role can edit/archive milestones of **any** project; matching against `project_lead_id`/`project_steward_id` happens only in the frontend.
³ `sign_off_plan` policy restricts to project_steward/operations_steward/founding_member (roles.go:129) but the endpoint is **not wired** through `RequireAction` — any caller succeeds, and the "user" can even be supplied in the request body (implementation_plans.go:155-163). UI shows the button only to admin/steward (useProjectPermissions.ts:44).
⁴ Backend also allows the plan's **assigned proposal steward** regardless of role, matched by AID **or by the spoofable `X-User-Name` header** (decision_plans.go:165-167).
⁵ All GET endpoints are unauthenticated — no `X-User-AID` needed (implementation_plans.go:91-112, decision_plans.go:117-136).
⁶ No house-membership, role, or eligibility check in backend or frontend; the only rules are proposal-in-voting-process, action-still-planned, and one vote per (self-declared) voter ID (service.go:1082-1128). Vote buttons render for any viewer (GovernanceActionModal.vue:292-295).

### Implementation Status

| Action | Policy (roles.go) | Backend Enforcement | Frontend Gating | Level | Evidence |
|---|---|---|---|---|---|
| Create implementation plan | none (no Action constant) | none — no middleware, no AID required | implicit: plan auto-created when adding first milestone, gated by `canAddMilestones` (admin/lead); a standalone "Create plan" dialog exists but nothing ever opens it (`showCreatePlanDialog` is never set true) | 🔶 Frontend-only | implementation_plans.go:36-45,73-88; main.go:607; ProjectDetailPage.vue:379,713,1266,1294; useProjectPermissions.ts:40 |
| List/get implementation plan + redline change log | none | none — unauthenticated GET | none — plan tab and "Show changes" redline visible to any project viewer | 🔶 Frontend-only (view is unrestricted) | implementation_plans.go:91-112; ProjectDetailPage.vue:235-241,261-266; PlanChangesRedline.vue |
| Add milestone to plan | none (no Action constant) | none — no middleware; actor AID used only for change-log attribution | `canAddMilestones` = admin ∨ lead, project not archived | 🔶 Frontend-only | implementation_plans.go:56-58,116-144; useProjectPermissions.ts:40-42; ProjectDetailPage.vue:163,180 |
| Edit milestone / set dates (`PUT /api/v1/milestones/{id}`) | `edit_milestone`: restricted-to: project_lead, project_steward, operations_steward, founding_member | `RBACMiddleware` + `RequireAction(ActionEditMilestone)`; edit invalidates plan sign-off and appends redline entry | `canEditMilestone`/`canAddMilestones` (admin/lead/steward); MilestoneCard edit button behind `canEdit` | ✅ Fully enforced¹ | milestones.go:57-65; roles.go:141,110-112; service.go:2528-2592; useProjectPermissions.ts:56; MilestoneCard.vue:44; ProjectDetailPage.vue:275 |
| Archive milestone (`POST /api/v1/milestones/{id}/archive`) | `archive_milestone`: restricted-to: leadStewardScope | `RBACMiddleware` + `RequireAction(ActionArchiveMilestone)`; also invalidates plan sign-off | `canArchiveMilestone` (admin/lead/steward) via MilestoneFormDialog `can-delete` | ✅ Fully enforced¹ | milestones.go:42-51; roles.go:138; service.go:2313-2360; useProjectPermissions.ts:53; ProjectDetailPage.vue:405,813 |
| Sign off implementation plan (`POST …/sign-off`) | `sign_off_plan`: restricted-to: project_steward, operations_steward, founding_member | **none** — route has no middleware; falls back to `X-User-AID` header or even `user_id` in body; only business-rule validation (milestones have contributions, contributions confirmed) | `canSignOffPlan` (admin ∨ steward) hides button; page also requires all milestones to have contributions | ⚠️ Policy not enforced | roles.go:72,129; implementation_plans.go:60-62,149-167; main.go:607; service.go:1977-2034; useProjectPermissions.ts:44; ProjectDetailPage.vue:153,211,244 |
| Create decision plan (`POST /api/v1/decision-plans`) | none | none — `OptionalRBACMiddleware` only populates context; handler has no check | `canManageDecisionPlan` = admin ∨ steward ∨ proposal lead gates the create/add-action buttons | 🔶 Frontend-only | decision_plans.go:28-37,98-114; ProposalDetailPage.vue:163-168,678-680 |
| List/get decision plans | none | none — unauthenticated GET | none — DecisionPlanView renders for any proposal viewer | 🔶 Frontend-only (view is unrestricted) | decision_plans.go:117-136; ProposalDetailPage.vue:231-254 |
| Transition decision plan (non-sign-off statuses) | none | none — only sign-off status branch is checked | `can-submit` prop from `canManageDecisionPlan` + status conditions | 🔶 Frontend-only | decision_plans.go:139-176; ProposalDetailPage.vue:239-244; DecisionPlanView.vue:72 |
| Sign off decision plan (transition→`signed_off`) | reuses `sign_off_plan` (restricted) | in-handler: `CanPerformAction(sign_off_plan)` OR assigned proposal steward (AID or `X-User-Name` match); 403 otherwise | `can-sign-off` = `canSignOffDecisionPlan` (admin ∨ steward ∨ proposal steward) + status checks | ✅ Fully enforced² | decision_plans.go:150-174; roles.go:129; ProposalDetailPage.vue:245-249,682-684; DecisionPlanView.vue:80 |
| Add governance action (`POST …/{id}/actions`) | none | none | `canManageDecisionPlan` via DecisionPlanView `canEdit` add-action button | 🔶 Frontend-only | decision_plans.go:52-60,219-233; DecisionPlanView.vue:63-68; ProposalDetailPage.vue:234-238 |
| Complete governance action (`POST /api/v1/governance-actions/{id}/complete`) | none | no role check; state rule only: decision plan must be `signed_off` | `canManage` block + `canCompleteAction` (plan signed off) | 🔶 Frontend-only | decision_plans.go:68-79,236-256; service.go:1011-1059; GovernanceActionModal.vue:53-54,268,472 |
| Archive governance action | none | none (state transition validation only) | inside `canManage` template block | 🔶 Frontend-only | decision_plans.go:81-84,259-277; service.go:1061-1080; GovernanceActionModal.vue:268 |
| Cast vote on decision action (`POST …/vote`) | none — no Action constant; KERI `"vote"` permission string exists but is never consulted | no role/house check; rules: decision-type action, status planned, proposal in `voting_process`, no duplicate self-declared voter ID | **none** — vote buttons shown to any viewer who hasn't voted; Elder Council veto/no-veto options keyed only off the action's house | ⚠️ Policy not enforced (unrestricted in both layers) | decision_plans.go:85-88,280-298; service.go:1082-1128; GovernanceActionModal.vue:292-336; keri/client.go:150 |
| Resolve decision / close voting (`POST …/resolve`) | none | none — tallies votes, applies Elder Council veto rule, no caller check | `canManage && votes > 0` on the Resolve button | 🔶 Frontend-only | decision_plans.go:89-92,301-309; service.go:1130-1191; GovernanceActionModal.vue:326 |

¹ "Fully enforced" at the role level only: the check is global (any qualifying role can edit/archive milestones on **any** project); per-project lead/steward matching is frontend-only (useProjectPermissions.ts:16-30, ProjectDetailPage.vue:682-690), and `X-User-AID` is an unverified header (rbac.go:31).
² Modulo the spoofable `X-User-Name` steward match (decision_plans.go:165-167) and unverified `X-User-AID`.

### Notes & Gaps

- **`sign_off_plan` is a paper policy for implementation plans.** roles.go:129 restricts it to steward roles, but the implementation-plans routes are registered with no RBAC at all (main.go:607); `HandleSignOff` will even take the signing user from the request body when no header is present (implementation_plans.go:155-163). Anyone who can reach the API can sign off any plan as any AID. The same policy IS enforced for decision-plan sign-off (decision_plans.go:157) — the asymmetry is easy to misread as coverage.
- **Governance voting is completely ungated.** No house-membership, role, or eligibility model exists in code: any AID can cast Community-house votes or Elder Council veto/no-veto (service.go:1082-1128, GovernanceActionModal.vue:292-295), and duplicate-vote protection keys on the caller-supplied `X-User-AID`, so vote stuffing only requires varying the header. `elder_council` exists as a Role (roles.go:18) but `MapKERIRole` never grants it and no house check references it (it appears only in `allRoles`, roles.go:103).
- **`X-User-AID` is never cryptographically verified** (rbac.go:31 just reads the header), so even the "fully enforced" milestone endpoints are spoofable; and `IdentityRoleLookup` grants Founding Member to the backend owner's own AID (rbac.go:186-192), meaning on a per-user backend the local user passes every `RequireAction` check by construction.
- **Milestone RBAC is global, not project-scoped.** `leadStewardScope` (roles.go:110-112) checks role membership only; a Technical Steward credential (→ `project_lead`, roles.go:42) can edit milestones on projects they have no relationship with. roles.go:98-99 documents this deliberately: project-level checks "are enforced on the frontend."
- **Spoofable `X-User-Name` fallback** in decision-plan sign-off: an assigned proposal steward can be impersonated by sending their display name as a header (decision_plans.go:165-167; frontend legitimately sends it at lib/api/decisionPlans.ts:83).
- **Add-milestone vs edit-milestone inconsistency**: adding a milestone (which creates plan content and can invalidate nothing) has no Action constant and no backend check, while editing/archiving one is RBAC-gated — a caller blocked from `PUT /milestones/{id}` can still `POST /implementation-plans/{id}/milestones`.
- **Read visibility is unrestricted at the API layer**: implementation plans (incl. budgets in `CreateImplementationPlanRequest.TotalBudget`, milestone `BudgetAllocation`) and decision plans are served on unauthenticated GETs (implementation_plans.go:91-112, decision_plans.go:117-136); the frontend's `canSeeContributionBudget` (useProjectPermissions.ts:75-77) is cosmetic for this data.
- **Redline change log** (`ImplementationPlan.ChangeLog`, models.go:334-360) is server-generated on milestone/contribution mutations and cleared on re-sign-off (service.go:2026-2028); viewing it is open to any project viewer (ProjectDetailPage.vue:235-241,261) — reasonable, but note attribution (`ChangedBy`) trusts the unverified header.
- **KERI permission strings are decorative here**: `GetPermissionsForRole` (keri/client.go:146-165) lists `"vote"`, `"propose"`, `"manage_governance"`, but its only call site is credentials.go:240, which just echoes them in a credential API response; no plans/governance handler consults them.
- **Design-doc drift**: `docs/design/PROJECTS_CONTRIBUTIONS_DOCUMENTATION.md` lines 384-405 show a purely client-side sign-off mutation from the legacy React prototype (no role check, no API), and the doc's role claims ("Sign-Off if project steward/community admin", line 539) describe UI intent, not enforcement. `docs/plans/2026-02-22-role-based-membership-design.md` covers credential-role plumbing but says nothing about plan/governance endpoint enforcement.
- The frontend's decision-plan admin gates hang off `identityStore.isSteward` — any credential whose role string contains "steward" or "founding member" (identity.ts:47-50) — which is broader than the backend's `sign_off_plan` role set (e.g. Treasury Steward passes the UI gate but fails the backend decision-plan sign-off check).

---

## Proposals & Endorsements

Proposals are community governance items that flow through a status machine (`draft → submitted → endorsing → in_review → signed_off → voting_process → approved → completed`, with `withdrawn`/`rejected` exits and shortcuts `submitted → in_review` / `in_review → draft` — `backend/internal/contributions/validation.go:28-36`). Endpoints live in `backend/internal/api/proposals.go`: the collection endpoint `/api/v1/proposals` (GET list, POST create) is wrapped in `RBACMiddleware` (requires an `X-User-AID` header, proposals.go:40), while all sub-resource routes `/api/v1/proposals/{id}[...]` — GET detail, PATCH update, POST transition, endorsements, history, comments — use `OptionalRBACMiddleware` (proposals.go:54), which does **not** reject unauthenticated requests. The UI surfaces are `frontend/src/pages/ProposalsPage.vue`, `frontend/src/pages/ProposalDetailPage.vue`, and the dialogs in `frontend/src/components/proposals/` (thin composables `useProposals.ts` / `useProposalEndorsements.ts` contain no permission logic).

Enforcement is entirely **handler-internal**: `RequireAction` is never used on any proposal route. Only three transitions are permission-checked — reject (`ActionRejectProposal`, proposals.go:203-215), sign-off (`ActionSignOffProposal` OR assigned proposal steward, proposals.go:220-244), and withdraw (proposer OR `ActionWithdrawProposal`, proposals.go:247-267) — plus content edits while `in_review` (proposer OR `ActionEditProposal`, proposals.go:393-410). The policy table grants these four proposal actions to `project_steward`, `operations_steward`, `community_steward`, `founding_member` (roles.go:133-136). Everything else — create, all other status transitions (including `submitted → in_review` and `voting_process → approved`), endorsing, commenting, and claiming the proposal lead/steward roles — has **no role check on the backend**. Identity itself is a plain `X-User-AID`/`X-User-Name` header with no cryptographic verification (rbac.go:29-46; the frontend sets `X-User-AID` from the local AID prefix in `frontend/src/lib/api/client.ts:35` and `X-User-Name` in `frontend/src/lib/api/proposals.ts:133,156`).

### Permission Matrix

| Action | Member | Contributor | Project Lead | Project Steward | Ops Steward | Community Steward | Tech Steward | Treasury Steward | Founding Member | Elder Council⁷ |
|---|---|---|---|---|---|---|---|---|---|---|
| Create proposal | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| View proposal list | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| View proposal detail / endorsements / history / comments | ✅⁶ | ✅⁶ | ✅⁶ | ✅⁶ | ✅⁶ | ✅⁶ | ✅⁶ | ✅⁶ | ✅⁶ | ✅⁶ |
| Edit proposal (draft/submitted/endorsing) | ✅⁵ | ✅⁵ | ✅⁵ | ✅⁵ | ✅⁵ | ✅⁵ | ✅⁵ | ✅⁵ | ✅⁵ | ✅⁵ |
| Edit proposal (in_review) | ✅¹ | ✅¹ | ✅¹ | ✅ | ✅ | ✅ | ✅¹ | ✅¹ | ✅ | ✅¹ |
| Claim proposal lead/steward role (PATCH role fields) | ✅⁵ | ✅⁵ | ✅⁵ | ✅⁵ | ✅⁵ | ✅⁵ | ✅⁵ | ✅⁵ | ✅⁵ | ✅⁵ |
| Submit for endorsement (draft→submitted) | ✅⁴ | ✅⁴ | ✅⁴ | ✅⁴ | ✅⁴ | ✅⁴ | ✅⁴ | ✅⁴ | ✅⁴ | ✅⁴ |
| Endorse proposal | ✅² | ✅² | ✅² | ✅² | ✅² | ✅² | ✅² | ✅² | ✅² | ✅² |
| Sign off proposal (in_review→signed_off) | ❌³ | ❌³ | ❌³ | ✅ | ✅ | ✅ | ❌³ | ❌³ | ✅ | ❌³ |
| Reject proposal (→rejected, from in_review or voting_process) | ❌ | ❌ | ❌ | ✅ | ✅ | ✅ | ❌ | ❌ | ✅ | ❌ |
| Withdraw proposal | ✅¹ | ✅¹ | ✅¹ | ✅ | ✅ | ✅ | ✅¹ | ✅¹ | ✅ | ✅¹ |
| Approve / other transitions (submitted/endorsing→in_review, signed_off→voting_process, voting_process→approved, approved→completed, in_review→draft) | ✅⁴ | ✅⁴ | ✅⁴ | ✅⁴ | ✅⁴ | ✅⁴ | ✅⁴ | ✅⁴ | ✅⁴ | ✅⁴ |
| Comment on proposal | ✅⁵ | ✅⁵ | ✅⁵ | ✅⁵ | ✅⁵ | ✅⁵ | ✅⁵ | ✅⁵ | ✅⁵ | ✅⁵ |
| Create project from approved proposal | ✅⁸ | ✅⁸ | ✅⁸ | ✅⁸ | ✅⁸ | ✅⁸ | ✅⁸ | ✅⁸ | ✅⁸ | ✅⁸ |

¹ Only if caller is the proposer — backend compares `X-User-AID`/`X-User-Name` against `proposer_id` (proposals.go:259, 400). Both headers are unverified.
² Any caller whose **body-supplied** `endorser_id` differs from `proposer_id`, and only while status is `submitted`/`endorsing` (service.go:359-364). No authentication required; self-endorsement is prevented only by an honest client. (The UI only offers the Endorse button while status is `submitted` — ProposalDetailPage.vue:97-107 — but the API also accepts endorsements during `endorsing`.)
³ Also allowed if the caller matches the proposal's `proposal_steward_id` (proposals.go:236-237) — and since anyone can PATCH `proposal_steward_id` (see ⁵/gaps), this is not a real restriction. Sign-off additionally requires both lead and steward assigned (service.go:248-254).
⁴ Endpoint performs **no permission check** for these transitions — only status-machine validity (proposals.go:191-269, validation.go:28-49). No `X-User-AID` required (OptionalRBACMiddleware). Note this includes `submitted → in_review`, which skips the endorsement threshold entirely.
⁵ **No backend check at all** — any caller, even without an `X-User-AID` header, succeeds (proposals.go:54, 105-114, 393, 446-482).
⁶ Read endpoints under `/api/v1/proposals/{id}` require no authentication (OptionalRBACMiddleware, proposals.go:54); the list endpoint requires an `X-User-AID` header but no role (proposals.go:40, rbac.go:31-35). Everyone sees all proposals including other users' drafts (ProposalsPage.vue:179-189).
⁷ `elder_council` is defined (roles.go:18) but no KERI role maps to it (`MapKERIRole`, roles.go:23-48) and it appears in no proposal action list — the column is theoretical.
⁸ Goes through `POST /api/v1/projects`, which *is* wired through `RequireAction(ActionCreateProject)` (projects.go:42) — but that policy entry is `allRoles` (roles.go:115), so any authenticated caller passes. The UI shows the button only to proposal lead/steward/admin (ProposalDetailPage.vue:181-198).

### Implementation Status

| Action | Policy (roles.go) | Backend Enforcement | Frontend Gating | Level | Evidence |
|---|---|---|---|---|---|
| create | none (no Action constant) | none — RBACMiddleware requires `X-User-AID` header only, no role check | none — "New Proposal" button shown to every user | ⚠️ Policy not enforced | proposals.go:40-49,117-157; rbac.go:29-46; ProposalsPage.vue:8-10 |
| view list | none | `X-User-AID` header required (401 without), no role check | none | ⚠️ Policy not enforced | proposals.go:40-43,160-174; rbac.go:31-35 |
| view detail / endorsements / history / comments | none | none — OptionalRBACMiddleware passes anonymous requests through | none | ⚠️ Policy not enforced | proposals.go:54,67-99; rbac.go:78-93 |
| edit_proposal (in_review, content fields) | restricted-to: project_steward, operations_steward, community_steward, founding_member | handler-internal: proposer identity OR `CanPerformAction(ActionEditProposal)` | Edit button `v-if="isSteward \|\| isProposer"` | ✅ Fully enforced | roles.go:135; proposals.go:393-410; ProposalDetailPage.vue:155 |
| edit_proposal (draft/submitted/endorsing) | restricted-to (same as above) | **none** — check only fires when `Status == ProposalInReview` | Edit button: draft = proposer only; submitted/endorsing = `v-if="isProposer \|\| isAdmin"` | 🔶 Frontend-only | proposals.go:393; ProposalDetailPage.vue:76-93,110,123 |
| claim proposal lead/steward (PATCH `proposal_lead_id`/`proposal_steward_id`) | none | none — `isRoleClaimOnly` explicitly exempts role fields from the edit check; no AID required | AssignRoleDialog opened only via `canAssignRoles = isAdmin \|\| isSteward` | 🔶 Frontend-only | proposals.go:105-114,393; ProposalDetailPage.vue:646,882-894 |
| withdraw_proposal | restricted-to: 4 steward/founding roles | handler-internal: proposer identity OR `CanPerformAction(ActionWithdrawProposal)` | `canWithdraw = isProposer \|\| isAdmin` on withdraw button | ✅ Fully enforced | roles.go:136; proposals.go:247-267; CreateProposalDialog.vue:219-227 |
| sign_off_proposal | restricted-to: 4 steward/founding roles | handler-internal: `CanPerformAction(ActionSignOffProposal)` OR caller == `proposal_steward_id`; service requires lead+steward assigned | Sign Off button `v-if="isSteward \|\| isProposalSteward"` | ✅ Fully enforced¹ | roles.go:133; proposals.go:220-244; service.go:248-254; ProposalDetailPage.vue:134-144 |
| reject_proposal | restricted-to: 4 steward/founding roles | handler-internal: `CanPerformAction(ActionRejectProposal)`, 401 without AID | Reject button `v-if="isSteward"` | ✅ Fully enforced² | roles.go:134; proposals.go:203-215; ProposalDetailPage.vue:145-154 |
| endorse proposal | none | status must be submitted/endorsing; body-supplied `endorser_id != proposer_id`; no auth | Endorse button hidden for proposer (`v-if="!isProposer"`) | 🔶 Frontend-only | service.go:354-400; proposals.go:328-358; ProposalDetailPage.vue:97-107,843-848 |
| other transitions incl. approve (draft→submitted, submitted/endorsing→in_review, in_review→draft, signed_off→voting_process, voting_process→approved, approved→completed) | none (no Action constants) | none — only `ValidateProposalTransition` status-machine check | buttons shown per status (submit: proposer only; approve reached via decision-plan resolve flow, `canManageDecisionPlan`) | 🔶 Frontend-only | proposals.go:191-269; validation.go:28-49; ProposalDetailPage.vue:76-85,163-178,678-680; useProposals.ts:27-37 |
| comment on proposal | none | none — `user_id`/`user_name` taken from request body, no AID required | none — comment box shown to all viewers | ⚠️ Policy not enforced | proposals.go:446-482; ProposalDetailPage.vue:389-407 |
| create project from approved proposal | `ActionCreateProject` = **allRoles** | `RequireAction(ActionCreateProject)` — wired, but grants every role | Create Project button `v-if="isProposalLead \|\| isProposalSteward \|\| isAdmin"` | ⚠️ Policy not enforced | roles.go:115; projects.go:42; ProposalDetailPage.vue:181-198 |

¹ Effectively bypassable: the unauthenticated role-claim PATCH lets any caller set `proposal_steward_id` to their own AID, then pass the assigned-steward branch of the sign-off check.
² Frontend `isSteward` is broader than the backend policy — see Notes & Gaps.

### Notes & Gaps

- **No cryptographic identity**: all enforcement keys off plain `X-User-AID` and `X-User-Name` headers (rbac.go:31, proposals.go:204,235,258,399; `X-User-AID` set client-side in frontend/src/lib/api/client.ts:35, `X-User-Name` in frontend/src/lib/api/proposals.ts:133,156). Any caller who can reach the backend can impersonate any proposer, steward, or admin.
- **Approve is unguarded**: `POST /api/v1/proposals/{id}/transition` only permission-checks `rejected`, `signed_off`, and `withdrawn`. Anyone — including anonymous callers — can drive `signed_off → voting_process → approved → completed`, jump `submitted → in_review` (skipping the endorsement threshold), or submit someone else's draft (proposals.go:191-269). The UI performs approval via decision-plan resolution (service.go:2231), but that flow is barely better protected: decision-plan and governance-action routes also use `OptionalRBACMiddleware` (decision_plans.go:28,39), and only the plan sign-off step is permission-checked (`ActionSignOffPlan` OR assigned steward, decision_plans.go:150-174) — vote/complete/resolve take an optional, unverified `X-User-AID` with no role check (decision_plans.go:248,269,290).
- **Privilege-escalation chain**: `isRoleClaimOnly` (proposals.go:105-114) lets any unauthenticated caller PATCH `proposal_steward_id` to themselves, after which the sign-off handler accepts them as "assigned proposal steward" (proposals.go:236-237). The frontend gates the AssignRoleDialog to admins/stewards (ProposalDetailPage.vue:646), but the API does not.
- **Endorsements are spoofable**: `endorser_id` comes from the request body with no auth (proposals.go:328-333); the "proposers cannot endorse their own proposal" rule (service.go:362-363) trusts that field. Fabricated endorsements auto-advance the proposal to `in_review` once the threshold is hit (service.go:380-395), which also auto-creates role contributions.
- **Anonymous read**: proposal detail, endorsements, history, and comments require no `X-User-AID` at all (OptionalRBACMiddleware, proposals.go:54); the list endpoint requires only the presence of the header. There is no draft privacy — all users see all proposals, including others' drafts (ProposalsPage.vue:175-189 offers a "Draft" filter over the full list).
- **Frontend/backend role mismatch on steward buttons**: `identityStore.isSteward` is a string match — any role containing "steward" or "founding member" (frontend/src/stores/identity.ts:47-50). Technical Steward and Treasury/Financial Steward therefore see Sign Off and Reject buttons, but `MapKERIRole` gives them neither `project_steward` nor `community_steward` (roles.go:36,40,42), so the backend returns 403.
- **`RequireAction` middleware is never used for proposal routes** — all four proposal policy entries are enforced by hand-rolled `CanPerformAction` calls inside `HandleTransition`/`HandleUpdate`. Edit enforcement only covers the `in_review` status; draft/submitted/endorsing content edits are unrestricted server-side (proposals.go:393).
- **`elder_council` is dead code** for this area: defined in roles.go:18 and included in `allRoles`, but no KERI role maps to it and it appears in no proposal action list.
- **KERI permission strings are decorative here**: `GetPermissionsForRole` grants `"propose"` only to steward/founding roles (backend/internal/keri/client.go:147-165), but its sole call site is the roles-listing endpoint `HandleRoles` (GET /api/v1/credentials/roles, backend/internal/api/credentials.go:228-245, call at :240) — it is never consulted for API authorization, and in practice every member can create proposals.
- **Design-doc drift**: the E2E spec in docs/design/PROJECTS_CONTRIBUTIONS_DOCUMENTATION.md:1886 asserts the "Create Proposal" button is hidden from plain members; the actual UI shows it to everyone (ProposalsPage.vue:8). Section 6 of that doc (line 899) documents an RBAC matrix that omits proposals and endorsements entirely, and docs/plans/2026-02-22-role-based-membership-design.md does not mention them.
- **Comment identity is body-supplied** (`user_id`, `user_name` — proposals.go:448-455), so proposal discussion entries can be attributed to anyone.

---

## Membership, Registration & Credentials

This area covers the full member lifecycle: an applicant submitting a registration (KERI EXN sent from the applicant's AID to the org admins' AIDs), endorsement of pending applicants by existing members, steward approval/decline (membership-credential issuance via signify-ts + KERIA, profile initialization via `POST /api/v1/profiles/init-member`, space invites via `POST /api/v1/spaces/community/invite`), role changes (`PUT /api/v1/members/{aid}/role`), member removal (`DELETE /api/v1/members/{aid}`), and the credential cache endpoints (`/api/v1/credentials*`). The UI lives almost entirely in `DashboardPage.vue` + `ProfileModal.vue` + `ChangeRoleModal.vue`, driven by `useAdminActions`, `useEndorsements`, `useRegistration`, `useRegistrationPolling`, `useEventAttendance`, and `useAdminAccess` (which wraps `stores/identity.ts` admin state).

Crucially, **none of the membership/registration/credential endpoints go through `RBACMiddleware`/`RequireAction`** — the `actionPermissions` table in `backend/internal/contributions/roles.go:114-145` contains no membership actions at all. The backend "has no authentication layer" by design (comment at `backend/internal/api/middleware.go:190-194`; `LocalhostGuard` restricts to loopback only in bundled mode), and `X-User-AID` is a plain header with no cryptographic verification (`backend/internal/api/rbac.go:29-46`). The real security backstops for the sensitive operations sit *outside* the app layer: credential issuance/revocation requires the org AID's signing keys in the caller's KERIA wallet (signify-ts), and writes to the community/readonly spaces plus invite creation require the caller's any-sync account to hold Writer/Admin (CanManageAccounts) permission at the consensus layer (`backend/internal/api/spaces.go:1180-1190`). Everything in between is frontend gating.

### Permission Matrix

Frontend gates key on the KERI **credential role string** (`isSteward` = role contains "steward" or "founding member", `frontend/src/stores/identity.ts:47-50`), not the contribution-role table.

| Action | Member | Contributor | Project Lead | Project Steward | Ops Steward | Community Steward | Tech Steward | Treasury Steward | Founding Member | Elder Council |
|---|---|---|---|---|---|---|---|---|---|---|
| Submit registration | ✅¹ | ✅¹ | —² | —² | ✅¹ | ✅¹ | ✅¹ | ✅¹ | ✅¹ | —² |
| View pending-registration queue (KERIA notifications) | ❌ | ❌ | —² | —² | ✅³ | ✅³ | ✅³ | ✅³ | ✅³ | —² |
| See pending applicants in members list | ✅ | ✅ | —² | —² | ✅ | ✅ | ✅ | ✅ | ✅ | —² |
| Endorse pending applicant | ✅⁴ | ✅⁴ | —² | —² | ✅⁴ | ✅⁴ | ✅⁴ | ✅⁴ | ✅⁴ | —² |
| Mark applicant event attendance | ❌ | ❌ | —² | —² | ✅ | ✅ | ✅ | ✅ | ✅ | —² |
| Approve registration / issue membership credential | ❌ | ❌ | —² | —² | ✅⁵ | ✅⁵ | ✅⁵ | ✅⁵ | ✅⁵ | —² |
| Decline registration | ❌ | ❌ | —² | —² | ✅ | ✅ | ✅ | ✅ | ✅ | —² |
| Message applicant | ❌¹¹ | ❌¹¹ | —² | —² | ❌¹¹ | ❌¹¹ | ❌¹¹ | ❌¹¹ | ❌¹¹ | —² |
| Change member role (non-steward roles) | ❌⁶ | ❌⁶ | —² | —² | ✅⁷ | ✅⁷ | ✅⁷ | ✅⁷ | ✅⁷ | —² |
| Upgrade member to steward (multisig + reissue) | ❌ | ❌ | —² | —² | ✅⁸ | ✅⁸ | ✅⁸ | ✅⁸ | ✅⁸ | —² |
| Remove member (revoke + soft-delete) | ❌⁶ | ❌⁶ | —² | —² | ✅⁷ | ✅⁷ | ✅⁷ | ✅⁷ | ✅⁷ | —² |
| Revoke membership credential | ❌ | ❌ | —² | —² | ✅⁸ | ✅⁸ | ✅⁸ | ✅⁸ | ✅⁸ | —² |
| View member list / profiles | ✅⁹ | ✅⁹ | —² | —² | ✅⁹ | ✅⁹ | ✅⁹ | ✅⁹ | ✅⁹ | —² |
| List / read / store / validate cached credentials | ✅¹⁰ | ✅¹⁰ | —² | —² | ✅¹⁰ | ✅¹⁰ | ✅¹⁰ | ✅¹⁰ | ✅¹⁰ | —² |

¹ Open to **anyone with a KERI AID**, including non-members — registration is a pre-membership EXN to the admin AIDs (`useRegistration.ts`); no gate exists or is intended.
² `project_lead`, `project_steward`, and `elder_council` are contribution-system roles derived from KERI roles (`roles.go:23-48`); they never appear as credential role strings, so credential-string frontend gates can't match them. `elder_council` is additionally unreachable — no KERI role maps to it.
³ Registrations are EXNs delivered only to the admin AIDs listed in org config; the dashboard polls the queue only when `isSteward` (`DashboardPage.vue:612,646-648`). A non-admin agent never receives them.
⁴ Any **approved member**: the flow requires the endorser's own membership credential and chains it as an ACDC edge (`useEndorsements.ts:81-125`); check is client-side but the edge makes forgery detectable at verification time.
⁵ UI additionally requires ≥1 endorsement AND an attendance record (`ProfileModal.vue:280,475-479`); the operative gate is possession of the org AID's signing keys in KERIA plus any-sync Admin permission for invite creation.
⁶ The backend endpoint has **no role check at all** — any local caller (any AID, or none) can invoke it directly.
⁷ Frontend gate is `isSteward && target !== self` (`DashboardPage.vue:219-220`) — broader than the documented Ops-Steward/Founding-Member restriction.
⁸ Genuinely enforced by KERI: multisig rotation and revocation require membership of the org group AID / org keys in the caller's KERIA wallet.
⁹ Effective visibility is governed by any-sync space membership (what your local backend has synced); the HTTP endpoints themselves are unauthenticated.
¹⁰ No check of any kind — any process that can reach the local backend port.
¹¹ **Not reachable from the UI by anyone.** `sendMessageToApplicant` (`useAdminActions.ts:780-848`) and the applicant-side reply `sendMessageToAdmin` (`useRegistration.ts:234`) are implemented as composables but have **no call sites in any component** — the message feature is currently unwired dead code.

### Implementation Status

| Action | Policy (roles.go) | Backend Enforcement | Frontend Gating | Level | Evidence |
|---|---|---|---|---|---|
| Submit registration | none | none (no backend endpoint; KERI EXN via signify) | none (open by design) | ⚠️ Policy not enforced (no policy exists; intentionally open) | frontend/src/composables/useRegistration.ts:49-160 |
| View pending-registration queue | none | none (queue = admin agent's KERIA notifications) | polls only when `isSteward` | 🔶 Frontend-only (KERIA delivery is the real gate) | DashboardPage.vue:612,646-648; useRegistrationPolling.ts:104,561-575 |
| Endorse pending applicant | none | none | button shown to any member not yet endorsed; own membership credential required client-side | 🔶 Frontend-only | ProfileModal.vue:262; useEndorsements.ts:81-96 |
| Approve registration (issue credential + init profiles + invite) | none | **none** on `POST /api/v1/profiles/init-member` and `POST /api/v1/spaces/community/invite`; backstop = org KERIA keys + any-sync Admin ACL | `isSteward && registration && requirementsMet` | 🔶 Frontend-only (app layer); KERI/any-sync backstop | profiles.go:391,974; spaces.go:719,1392; ProfileModal.vue:280; useAdminActions.ts:190-453 |
| Decline registration | none | **none** (`POST /api/v1/profiles` profile update is open) | `isSteward && registration` | 🔶 Frontend-only | ProfileModal.vue:290; useAdminActions.ts:672-772; profiles.go:89,971 |
| Mark applicant attendance | none | none (attendance credential issued from steward's own AID via signify) | `isSteward` | 🔶 Frontend-only | ProfileModal.vue:240-251; useEventAttendance.ts:43-184; DashboardPage.vue:891 |
| Message applicant | none | none (no backend endpoint; KERI EXN via signify) | **none — flow not wired to any UI**; `sendMessageToApplicant`/`sendMessageToAdmin` have no component call sites | 🔶 Frontend-only (currently dead code) | useAdminActions.ts:780-848; useRegistration.ts:234 |
| Change member role (`PUT /api/v1/members/{aid}/role`) | none | **none** — only `keri.IsValidRole` value validation; handler never reads caller AID | `canChangeRole = isSteward && !self`; client sends no `X-User-AID` | 🔶 Frontend-only | profiles.go:668-778 (esp. 691), 980-982; DashboardPage.vue:219; client.ts:461-470 |
| Upgrade member to steward | none | none in app; KERI multisig requires org-group membership | `isSteward` via ChangeRoleModal; **only "Founding Member" and "Community Steward" trigger the upgrade path** (`STEWARD_ROLES`, ChangeRoleModal.vue:140) | 🔶 Frontend-only (KERI-enforced in practice) | useAdminActions.ts:464-608; ChangeRoleModal.vue:140-263 |
| Remove member (`DELETE /api/v1/members/{aid}`) | none | **none** — no auth, no role check; `removedBy` recorded as backend's own identity AID | `canRemoveMember = isSteward && !self` | 🔶 Frontend-only | profiles.go:787-907, 984-987; DashboardPage.vue:220; client.ts:989-1005; useAdminActions.ts:858-937 |
| Revoke membership credential | none | none in app; requires org AID keys in caller's KERIA wallet | inside steward-only flows | 🔶 Frontend-only (KERI-enforced in practice) | useAdminActions.ts:528-544,903; keri/client.ts:2045 |
| Grant steward any-sync Admin (`POST /api/v1/spaces/grant-steward-admin`) | none | no handler check; any-sync SDK rejects PermissionChange from non-owner at consensus layer | none (called only from the steward-upgrade flow, useAdminActions.ts:591) | 🔷 Backend-only (data-layer, not handler) | spaces.go:1180-1253,1396 |
| Store credential (`POST /api/v1/credentials`) | none | **none**; structural validation only, no signature check | none | ⚠️ Policy not enforced (no policy exists; unrestricted at every layer) | credentials.go:80-131,265; keri/client.go:105-127 |
| List/get credentials (`GET /api/v1/credentials`, `/{said}`) | none | **none** — returns all cached credentials to any caller | none | ⚠️ Policy not enforced (no policy exists; unrestricted) | credentials.go:134-181,296-330 |
| Validate credential / list roles / org info endpoints | none | none (read-only) | none | ⚠️ Policy not enforced (benign reads) | credentials.go:184-245 (validate, roles), 248-257 (`GET /api/v1/org`) |
| Member list / profile visibility (`GET /api/v1/profiles/{type}`, `/api/v1/profiles/me`) | none | **none** at HTTP layer; visibility = any-sync space membership; removed profiles NOT filtered server-side | removed/pending/declined filtered client-side only | 🔶 Frontend-only (any-sync provides read boundary) | profiles.go:215-302,305; DashboardPage.vue:684 |
| RBAC role resolution (who counts as what role) | `MapKERIRole` | `CompositeRoleLookup` chain, in order: **ProfileRoleLookup** (reads `role` from CommunityProfile/SharedProfile in the readonly space; org-config admin AIDs → Founding Member; **defaults to `member` for any AID**) → OrgConfigAdminLookup → CredentialRoleLookup (issuer and `Verified` **not** checked) → IdentityRoleLookup. ProfileRoleLookup never errors and never returns empty, so the last three lookups are **effectively unreachable** | admin state cached in identity store (credential role / org-group membership / config admins) | 🔷 Backend-only | cmd/server/main.go:517-521; contributions/role_store.go:30-77; rbac.go:100-215; identity.ts:225-336 |
| KERI permission strings (`GetPermissionsForRole`) | n/a | **never consulted** — sole call site is the informational `GET /api/v1/credentials/roles` | n/a | 📄 Documented only (decorative) | keri/client.go:146-165; credentials.go:236-244 |

### Notes & Gaps

- **No membership action appears in the RBAC policy table.** `actionPermissions` (roles.go:114-145) covers only projects/contributions/proposals; the entire member-lifecycle API is outside `RequireAction`.
- **`PUT /api/v1/members/{aid}/role` and `DELETE /api/v1/members/{aid}` have zero authorization** — the handlers never read the caller's AID and are registered without middleware (profiles.go:968-989). Both design docs claim restriction to Operations Steward/Founding Member (`2026-02-24-admin-member-removal-design.md:20` "Authorization: `canManageMembers` permissions only"; `2026-02-22-role-based-membership-design.md:70`). The claimed restriction exists nowhere in backend code.
- **Frontend gate is broader than designed:** `canManageMembers` (Ops Steward/Founding Member, identity.ts:52-55) is computed and even imported in DashboardPage.vue:286 but **never used** — Change Role and Remove Member buttons use `isSteward`, so Community/Technical/Treasury/etc. stewards also get them (DashboardPage.vue:219-220).
- **Privilege-escalation path via the open role-change endpoint:** the role that `RequireAction` checks comes from `ProfileRoleLookup`, which reads the `role` field of the CommunityProfile in the readonly space (role_store.go:30-77) — and `PUT /api/v1/members/{aid}/role` writes exactly that field with **no authorization** (profiles.go:750-767). Any local caller can therefore set any existing member's role — including their own — to "Operations Steward"/"Founding Member" and pass every `RequireAction` gate in the app. A second, *latent* weakness sits in the credential cache: `POST /api/v1/credentials` accepts any structurally-valid credential without signature verification (keri/client.go:106 comment: verification "should be done by signify-ts"), and `CredentialRoleLookup` (rbac.go:136-166) maps the cached `role` field for a matching `X-User-AID` **without checking issuer or the `Verified` flag**. As wired, however (main.go:521), `ProfileRoleLookup` always returns at least `member` and never errors, so `CredentialRoleLookup` (and the org-config/identity fallbacks behind it) are effectively dead code — the fake-credential escalation only becomes live if the lookup order changes. Mitigated only by the per-user/localhost deployment model (middleware.go:190-218).
- **Design drift on role change:** the role-based-membership design (`2026-02-22`, lines 40, 51) says every role change revokes the old credential and issues a new one; in code only changes to **"Founding Member" or "Community Steward"** do — `STEWARD_ROLES` (ChangeRoleModal.vue:140) omits Operations/Financial/Governance/Treasury/Technical/Cultural Steward, so those changes (like all non-steward changes) update the CommunityProfile only (ChangeRoleModal.vue:239-263). The member's actual credential keeps the old role and diverges from the profile; a member "promoted" to Operations Steward this way gets full `isSteward` UI powers and steward RBAC roles (via ProfileRoleLookup) while still holding a Member credential.
- **The message-applicant feature is unwired:** both directions (`sendMessageToApplicant`, useAdminActions.ts:780-848; `sendMessageToAdmin`, useRegistration.ts:234) exist as composables but are invoked from no component — the matrix row exists in code only.
- **Member removal is implemented** (design doc `2026-02-24` → profiles.go:787-907 + useAdminActions.ts:858-937) but its authorization clause was not; also removal does not evict the member from any-sync spaces (acknowledged in the design at line 34: "No any-sync ACL eviction").
- Removed/declined members are filtered **client-side only** (DashboardPage.vue:684); `GET /api/v1/profiles/SharedProfile` still returns them.
- `elder_council` is defined in roles.go:18 but unreachable — `MapKERIRole` (roles.go:23-48) never produces it, and it appears only in `allRoles`, never in a restricted `actionPermissions` set.
- Approval requirements (≥1 endorsement + attendance) are enforced purely in the modal (`ProfileModal.vue:475-479`); a steward calling `useAdminActions.approveRegistration` (or the underlying endpoints/KERIA) directly bypasses them.
- Endorsement matches its design doc (`2026-02-19-membership-endorsement-design.md:12`: "Any approved member can endorse") — one of the few places code and docs agree.
- `X-User-AID` is an unverified header everywhere it is used; identity endpoints (`/api/v1/identity/set`, `DELETE /api/v1/identity` — identity.go:461-462) are likewise unauthenticated, consistent with the local single-user trust model.

---

## Communication & Content (Notices, Chat, Events, Files)

This area covers the community notice board (`/api/v1/notices*`, rendered on `ActivityPage.vue`), chat channels and messages (`/api/v1/chat/*`, `ChatPage.vue` + `frontend/src/components/chat/`), the SSE event stream (`/api/v1/events`), event-attendance credentials (issued client-side via KERI from `DashboardPage.vue`/`ProfileModal.vue` through `useEventAttendance.ts` — there is no backend endpoint for this), file upload/download (`/api/v1/files/*`), and invite/booking emails (`/api/v1/invites/send-email`, `/api/v1/booking/send-email`).

**The single most important finding: not one endpoint in this area is wired through `RBACMiddleware`/`RequireAction`, and `backend/internal/contributions/roles.go` defines no Action constants for notices, chat, events, files, or emails at all** (a repo-wide grep for `RequireAction|RBACMiddleware` matches only projects/milestones/contributions/proposals/decision-plans). All role gating in this area is frontend `v-if` on `identityStore.isSteward` (true when the user's admin-credential role string contains "steward" or "founding member" — `frontend/src/stores/identity.ts:47-50`). The comms handlers do not even read the `X-User-AID` header; authorship is taken from the backend's own local identity (`h.userIdentity.GetAID()`), consistent with the per-user-backend architecture. The only backend-side protections are: (a) chat message edit/delete ownership checks against the local identity, (b) a *broken* channel `AllowedRoles` visibility filter, and (c) `LocalhostGuard`, which restricts the whole API to loopback callers in bundled mode only (`middleware.go:195-218`). Any process that can reach the port can perform every action below.

### Permission Matrix

| Action | Member | Contributor | Project Lead | Project Steward | Ops Steward | Community Steward | Tech Steward | Treasury Steward | Founding Member | Elder Council |
|---|---|---|---|---|---|---|---|---|---|---|
| Create notice (draft or published) | ❌¹ | ❌¹ | ❌¹ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌¹ |
| Publish / archive notice | ❌¹ | ❌¹ | ❌¹ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌¹ |
| Pin notice | ❌¹ | ❌¹ | ❌¹ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌¹ |
| View notices / view RSVP & ack lists | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| RSVP / acknowledge notice | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Comment / react on notice | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Save notice (personal pin, private space) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Create chat channel | ❌¹ | ❌¹ | ❌¹ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌¹ |
| Edit / archive (delete) chat channel | ❌¹ | ❌¹ | ❌¹ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌¹ |
| See role-restricted channel | ❌³ | ❌³ | ❌³ | ❌³ | ❌³ | ❌³ | ❌³ | ❌³ | ❌³ | ❌³ |
| Read channel messages (incl. restricted channels) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Send chat message | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Edit / delete own chat message | ✅² | ✅² | ✅² | ✅² | ✅² | ✅² | ✅² | ✅² | ✅² | ✅² |
| Edit / delete another user's message | ❌² | ❌² | ❌² | ❌² | ❌² | ❌² | ❌² | ❌² | ❌² | ❌² |
| React to message / update own read cursors | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Issue event-attendance credential | ❌¹ ⁴ | ❌¹ ⁴ | ❌¹ ⁴ | ✅⁴ | ✅⁴ | ✅⁴ | ✅⁴ | ✅⁴ | ✅⁴ | ❌¹ ⁴ |
| Trigger invite email | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Choose initial role on invite | ❌¹ | ❌¹ | ❌¹ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌¹ |
| Trigger booking email | ✅⁵ | ✅⁵ | ✅⁵ | ✅⁵ | ✅⁵ | ✅⁵ | ✅⁵ | ✅⁵ | ✅⁵ | ✅⁵ |
| Upload file (20 MB max) / download file by CID | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Subscribe to SSE event stream (all chat + notice content) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |

¹ UI-only restriction. The backend endpoint has **no role check whatsoever** — any local caller (curl to the port, or any role via a modified client) can perform the action. "Steward" columns are ✅ because `identityStore.isSteward` matches any credential role containing "steward" (`identity.ts:47-50`); Elder Council / Member / Contributor / Project Lead see no button but the API accepts them.
² Ownership enforced by comparing the message's `senderAid` with the backend's **own local identity** (`chat.go:952-955`, `chat.go:1102-1105`) — not against `X-User-AID`, and not cryptographically. It holds per honest node; a modified peer backend could write arbitrary edits into the shared tree.
³ **Broken feature**: channel `AllowedRoles` filtering exists (`chat.go:220-222`, `273-275`, `311-313`) but `getUserRole()` is a TODO stub returning `""` (`chat.go:1776-1780`), so any channel with a non-empty `AllowedRoles` is hidden/403 for *everyone*, including stewards and its creator — while its messages remain fully readable via the messages endpoint (see gap below).
⁴ No backend involvement at all: issuance happens in the browser via signify-ts against the user's own KERIA agent. The only substantive check is client-side: the host must hold a membership credential (`useEventAttendance.ts:85-94`), i.e. **any admitted member** can technically issue; UI shows the button only to stewards (`ProfileModal.vue:240`).
⁵ By design pre-membership: booking emails are sent from the onboarding `PendingApprovalScreen.vue:540` before the applicant has any role.

### Implementation Status

| Action | Policy (roles.go) | Backend Enforcement | Frontend Gating | Level | Evidence |
|---|---|---|---|---|---|
| Create notice | none (no Action constant) | none — routes registered bare, handler only checks local identity is configured | `v-if="isSteward"` on create button + drafts section | 🔶 Frontend-only | notices.go:37-41, 155-204; ActivityPage.vue:9,30,80; identity.ts:47-50 |
| Publish notice | none | none — state-transition validity only (`IsValidNoticeTransition`) | Publish button `v-if="isSteward"` | 🔶 Frontend-only | notices.go:409-416, 429-451; FeedCard.vue:77-84,114 |
| Archive notice | none | none | Archive button inside `isSteward` block | 🔶 Frontend-only | notices.go:419-426; FeedCard.vue:77,85-91 |
| Pin notice | none | none | Pin button `v-if="isSteward"` | 🔶 Frontend-only | notices.go:1025-1080; FeedCard.vue:14-20 |
| RSVP / ack / comment / react / save notice | none | none (identity-configured check only; save & read-cursors write to caller's private space) | none — shown to all members | ⚠️ Policy not enforced (open to all; no policy exists) | notices.go:494, 593, 669-692, 786, 898 |
| List notices / RSVPs / acks / comments / reactions / saved | none | none — anyone can read, incl. per-user RSVP and ack lists | none | ⚠️ Policy not enforced | notices.go:304, 560-590, 643-666, 739-778, 867-890, 989-1022 |
| Create chat channel | none | none | "+" button `v-if="isAdmin"` (= isSteward) | 🔶 Frontend-only | chat.go:330-445, 2096-2120; ChannelSidebar.vue:9,62 |
| Edit / archive channel | none | none | Settings gear `v-if="isAdmin"` opens ChannelSettingsModal | 🔶 Frontend-only | chat.go:448-575, 578-682; ChannelHeader.vue:12,38 |
| Channel visibility (AllowedRoles) | none | present but broken: filter compares against stub `getUserRole()` returning `""` | CreateChannelModal's "Admins only" option writes a fixed `['admin','steward']`; ChannelSettingsModal has **no** roles UI at all | ⚠️ Policy not enforced (enforcement stubbed) | chat.go:220-222, 273-275, 311-313, 1776-1780; CreateChannelModal.vue:139 |
| Read messages | none | none — no AllowedRoles check on messages endpoints | none | ⚠️ Policy not enforced | chat.go:687-724, 1917-2017 |
| Send message | none | none (sender stamped from local backend identity) | none — composer shown to all | ⚠️ Policy not enforced | chat.go:727-860, 765-770 |
| Edit / delete own message | none | handler-internal ownership check vs local identity (403 otherwise) | edit/delete actions `v-if="isOwnMessage"` | ✅ Fully enforced² | chat.go:952-955, 1102-1105; MessageItem.vue:64-79 |
| Message reactions | none | duplicate-reaction check only | none | ⚠️ Policy not enforced | chat.go:1258-1429, 1432-1584 |
| Read cursors (get/update) | none | none — but scoped to caller's private space + own AID key | n/a (personal) | ⚠️ Policy not enforced (self-scoped by construction) | chat.go:1589-1644, 1647-1772 |
| Issue attendance credential | none | **no backend endpoint** — pure client-side KERI issuance; client verifies host holds a membership credential | Mark Attended button `v-if="props.isSteward"` | 🔶 Frontend-only | useEventAttendance.ts:43-181, 85-94; ProfileModal.vue:240-251; DashboardPage.vue:885-892 |
| Trigger invite email | none | none — input validation only; endpoint sends via org SMTP | Invite button visible to **all** members (ungated); only the initial-role dropdown is `v-if="isSteward"` | ⚠️ Policy not enforced | invites.go:39-113, 116-118; DashboardPage.vue:164-170, 202; InviteMemberModal.vue:41-59 |
| Trigger booking email | none | none — input validation only | onboarding flow (pre-identity), open by design | ⚠️ Policy not enforced | booking.go:42-119, 122-124; PendingApprovalScreen.vue:540 |
| File upload | none | none — 20 MB size cap only | none — attachment UIs open to all members | ⚠️ Policy not enforced | files.go:39-120, 236-239 |
| File download | none | none — any valid CID served with public immutable cache headers | none | ⚠️ Policy not enforced | files.go:124-174, 170-172 |
| SSE event stream | none | none — any subscriber receives all notice + chat broadcast payloads (incl. message content) | n/a | ⚠️ Policy not enforced | events.go:78-131, 134-136; chat.go:842-852 |
| Legacy KERI permissions ("comment", "moderate", …) | n/a (separate list in keri/client.go) | never consulted for enforcement — only echoed in `GET /api/v1/credentials/roles` listing | n/a | 📄 Documented only (decorative) | keri/client.go:147-165; credentials.go:227-245 (sole call site) |

### Notes & Gaps

- **No RBAC wiring anywhere in this area.** `grep RequireAction|RBACMiddleware` across `backend/` hits only projects, milestones, contributions, proposals and decision-plans — never notices, chat, files, invites, booking or events. Every "steward-only" action here is one curl away for any caller.
- **Comms handlers ignore `X-User-AID` entirely.** Authorship comes from the backend's own identity (`userIdentity.GetAID()`, e.g. notices.go:197-199, chat.go:765-768). This fits the per-user-backend model, but it means the sole real boundary is `LocalhostGuard` (`middleware.go:195-218`), which is active **only** when `MATOU_CORS_MODE=bundled`; in dev/test the API is open to any network caller. Elsewhere in the app `RBACMiddleware` trusts `X-User-AID` without cryptographic verification (rbac.go:29-46) — this area doesn't even read it.
- **Channel role restriction is doubly broken.** (1) `ChatHandler.getUserRole()` carries a `TODO` and returns `""` (chat.go:1776-1780), so `AllowedRoles` channels are hidden/403 for everyone including the steward who created them. (2) Even if the stub were fixed to return the user's real KERI role, the values the UI writes — a fixed `['admin','steward']` from CreateChannelModal's "Admins only" option (CreateChannelModal.vue:139) — would never match real role strings like "Community Steward" under `containsRole`'s exact case-insensitive comparison (chat.go:1807-1814). Meanwhile `HandleListMessages`/`HandleGetThread` never check `AllowedRoles` at all, so "restricted" channel messages are readable by anyone with the channel ID. Restricted channels are excluded from the channel listing before the archived filter (chat.go:220-223), so their IDs don't appear there — but the ID and name of every channel (restricted or not) are broadcast to every SSE subscriber on creation/update (`chat:channel:new`/`chat:channel:update`, chat.go:432-438, 561-567), and the message tree scan filters only on channelID (chat.go:1938).
- **SSE leak:** `/api/v1/events` requires no identity and re-broadcasts full chat message content and notice metadata to every subscriber (events.go:78; chat.go:842-852).
- **Invite email endpoint is an open relay** for the configured SMTP sender: no role check, no rate limit, arbitrary recipient/inviter-name strings (invites.go:39-113). The invite *button* is shown to every member (DashboardPage.vue:164-170); only the initial-role picker is steward-gated in the UI (InviteMemberModal.vue:41) — and role selection itself is enforced nowhere server-side.
- **Attendance credentials:** design doc `docs/plans/2026-02-20-event-attendance-credential-design.md` says "Admin/steward who hosts a session manually issues" — in code, the only hard requirement is holding *any* membership credential (`useEventAttendance.ts:85-94`); the steward restriction is a `v-if` (ProfileModal.vue:240). The KERI credential is at least cryptographically attributable to its issuer, so misuse is detectable, but nothing verifies the issuer's role at admission time.
- **Message edit/delete is the one genuinely enforced rule** (own-messages-only, chat.go:952/1102 + MessageItem.vue:71), with the caveat that it is per-honest-node: enforcement compares against the local backend identity, and the shared any-sync tree does not itself reject a forged edit from a modified peer.
- **`GetPermissionsForRole()` is decorative.** Its "comment"/"moderate"/"admin" strings (keri/client.go:147-165) are only ever serialized into the `GET /api/v1/credentials/roles` informational listing (credentials.go:240); no code path checks them, and they don't correspond to any enforced capability in notices/chat.
- Notices "events" (type=event with RSVP) are the app's only event objects — `events.go` is unrelated (SSE broker). RSVP capacity (`rsvpCapacity`) is stored but never enforced server-side (notices.go:494-557 does no capacity check).
- `docs/design/PROJECTS_CONTRIBUTIONS_DOCUMENTATION.md` mentions in-app chat and file upload only as roadmap items (§ lines 2059, 2099) and makes no permission claims for this area, so no doc-vs-code drift beyond the attendance-credential doc noted above.

---

## Spaces, Sync & Admin Infrastructure

This area covers the any-sync space fabric and the low-level infrastructure endpoints that sit underneath the app: space creation/join/invite (`/api/v1/spaces/*`), the steward-admin elevation endpoint, credential/KEL sync (`/api/v1/sync/*`), community roster/credential reads (`/api/v1/community/*`), the trust graph (`/api/v1/trust/*`), org configuration (`/api/v1/org/*`), multisig rotation coordination (`/api/v1/multisig/*`), per-user comment cursors (`/api/v1/comment-cursors`), and the type-definition registry (`/api/v1/types`). Handlers live in `backend/internal/api/{spaces,sync,trust,org,multisig,comment_cursors,profiles}.go`; the any-sync ACL/space machinery is in `backend/internal/anysync/{acl,spaces}.go`. Frontend callers are in `frontend/src/lib/api/client.ts`, `src/api/config.ts`, `src/composables/useAdminActions.ts`, `useMultisigRotationSignal.ts`, `useOrgSetup.ts`, `src/lib/keri/client.ts`, and `src/lib/api/commentCursors.ts`. (`useMultisigJoin.ts` is part of the multisig flow but calls **no** backend endpoint — it consumes KERIA `/multisig/rot` notifications only.)

The headline fact for this entire area: **not one endpoint here is wired through `RequireAction` / `RBACMiddleware` / `OptionalRBACMiddleware`.** The grep for RBAC wiring returns hits only in `backend/internal/api/{milestones,contributions_handler,proposals,projects,decision_plans}.go` (plus `rbac.go` itself) — *zero* hits in any spaces/sync/trust/org/multisig/comment-cursors/types file — and each handler's `RegisterRoutes` mounts the handler with no auth wrapper (`spaces.go:1390-1400`, `sync.go:527-535`, `trust.go:274-279`, `org.go:216-219`, `multisig.go:32-35`, `comment_cursors.go:42-44`; the org/multisig/comment-cursors routes are wrapped in `CORSHandler`, which adds CORS headers only, no auth). Authorization for the ACL-mutating operations (invite, join, grant-steward-admin) is therefore **not an application check at all** — it is enforced one layer down by the any-sync consensus node, which rejects ACL records not signed by the space owner/admin key (`spaces.go:1188-1189` documents this; `acl.go:260-309` `ChangePermissions` builds a `PermissionChange` record the SDK signs with the loaded space key). Note this gate authenticates the **backend's key**, not the HTTP caller: on the owner's machine, any local process that can reach the port succeeds. The `X-User-AID` header is **never cryptographically verified** anywhere (`rbac.go:31` reads the header string verbatim), but since these routes don't consult it, the practical guard is the network boundary: `LocalhostGuard` (`middleware.go:195-218`) rejects non-loopback requests when `MATOU_CORS_MODE=bundled` (the whole mux is wrapped as `RequestLogger(LocalhostGuard(CORSMiddleware(mux)))`, `cmd/server/main.go:761`), and the backend is designed as a localhost-only child process of the Electron app with "no authentication layer" (its own comment, `middleware.go:190-194`).

### Permission Matrix

Because no endpoint in this area reads roles, the matrix below reflects who the CODE actually lets through. "✅" = the HTTP endpoint accepts the call from any caller that reaches the port; where a *deeper* (consensus-layer or key-possession) gate exists, it is footnoted. Read endpoints are all fully open.

| Action | Member | Contributor | Project Lead | Project Steward | Ops Steward | Community Steward | Tech Steward | Treasury Steward | Founding Member | Elder Council |
|---|---|---|---|---|---|---|---|---|---|---|
| Create community/private space | ✅¹ | ✅¹ | ✅¹ | ✅¹ | ✅¹ | ✅¹ | ✅¹ | ✅¹ | ✅¹ | ✅¹ |
| Read community space info | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Create community invite | ✅² | ✅² | ✅² | ✅² | ✅² | ✅² | ✅² | ✅² | ✅² | ✅² |
| Join community (with invite key) | ✅³ | ✅³ | ✅³ | ✅³ | ✅³ | ✅³ | ✅³ | ✅³ | ✅³ | ✅³ |
| Verify-access (read) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Grant steward Admin (ACL elevation) | ✅⁴ | ✅⁴ | ✅⁴ | ✅⁴ | ✅⁴ | ✅⁴ | ✅⁴ | ✅⁴ | ✅⁴ | ✅⁴ |
| Sync credentials / KEL | ✅⁵ | ✅⁵ | ✅⁵ | ✅⁵ | ✅⁵ | ✅⁵ | ✅⁵ | ✅⁵ | ✅⁵ | ✅⁵ |
| Read community members/credentials | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Read trust graph/scores/summary | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Read org config (GET /org/config) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Write org config (POST /org/config) | ✅⁶ | ✅⁶ | ✅⁶ | ✅⁶ | ✅⁶ | ✅⁶ | ✅⁶ | ✅⁶ | ✅⁶ | ✅⁶ |
| Delete org config (DELETE) | ✅⁶ | ✅⁶ | ✅⁶ | ✅⁶ | ✅⁶ | ✅⁶ | ✅⁶ | ✅⁶ | ✅⁶ | ✅⁶ |
| Post multisig rotation-signal/ack | ✅⁷ | ✅⁷ | ✅⁷ | ✅⁷ | ✅⁷ | ✅⁷ | ✅⁷ | ✅⁷ | ✅⁷ | ✅⁷ |
| Read/write own comment cursors | ✅⁸ | ✅⁸ | ✅⁸ | ✅⁸ | ✅⁸ | ✅⁸ | ✅⁸ | ✅⁸ | ✅⁸ | ✅⁸ |
| Read type definitions (/types) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |

**Footnotes:**
1. ¹ No role check. `HandleCreateCommunity`/`HandleCreatePrivate` require only that an identity/mnemonic is configured on the backend (`spaces.go:295-301`, `577-605`); this is a per-user backend so "the caller" is effectively the backend owner, but the endpoint itself performs no role gate.
2. ² No role check at the HTTP layer. `CreateOpenInvite` succeeds only if the backend holds the space's Admin/owner signing key (consensus-enforced, `acl.go:64-148`); any local caller can trigger it.
3. ³ No role check. Possession of a valid base64 invite key is the only gate (`spaces.go:853-1025`). Anyone holding the key can join.
4. ⁴ No HTTP auth. Elevation only *lands* if the backend's space key is the owner (consensus rejects otherwise — `spaces.go:1188-1189`, `acl.go:264`). Any local caller can POST it; a non-owner backend just gets a consensus error back.
5. ⁵ No role check. Writes to the caller's own private space (falls back to local identity, `sync.go:127-138`). Credentials are structurally validated (`keri/client.go:107-127`) and marked `Verified` only if org-issued (`sync.go:172`), but any credential is still cached and routed.
6. ⁶ **No auth of any kind.** `handleConfig` dispatches GET/POST/DELETE with no header or role check (`org.go:222-235`; save `org.go:147-199`, delete `org.go:239-264`). Writing this file mutates the `Admins` list that `OrgConfigAdminLookup` maps to Founding Member (`rbac.go:112-122`) — see Gaps.
7. ⁷ No role check. Writes a signal/ack object to the community space using the backend's own space signing key (`multisig.go:159-189`).
8. ⁸ No header auth, but strictly scoped: reads/writes only `comment-cursors-<localAID>` in the local user's own private space (`comment_cursors.go:57-69`, `107-133`).

### Implementation Status

No space/sync/trust/org/multisig action constant exists in `contributions/roles.go`, so "⚠️ Policy not enforced" rows below are actually one step *worse* than the legend's baseline: there is no policy entry at all — the endpoint is fully open to any caller reaching the port.

| Action | Policy (roles.go) | Backend Enforcement | Frontend Gating | Level | Evidence |
|---|---|---|---|---|---|
| Create community space (`POST /spaces/community`) | none (no Action constant) | none — only "identity configured" precondition | Org-setup flow only (`useOrgSetup.ts:184`) | 🔶 Frontend-only | spaces.go:220-492,1391; useOrgSetup.ts:184; roles.go (no space actions) |
| Get community space info (`GET /spaces/community`) | none | none (read) | no UI caller found | ⚠️ Policy not enforced (open read) | spaces.go:552-574,1109-1120,1391 |
| Create private space (`POST /spaces/private`) | none | none — "userAid or identity" precondition | **no frontend caller at all** — private spaces are created backend-internally (`sync.go:147,276` → `GetOrCreatePrivateSpace`) | ⚠️ Policy not enforced (no gate anywhere; endpoint effectively unused by UI) | spaces.go:577-717,1397; anysync/spaces.go:219 |
| Create community invite (`POST /spaces/community/invite`) | none | Consensus-layer only (needs owner/Admin space key — gates the backend, not the caller) | Called only in steward approval flow (`useAdminActions.ts:282`) | 🔶 Frontend-only (consensus key gate underneath, not RBAC) | spaces.go:719-834,1392; acl.go:64-148; useAdminActions.ts:282 |
| Create readonly invite (`POST /spaces/community-readonly/invite`) | none | Consensus-layer only | not directly called (folded into community/invite response) | 🔷 Backend-only (consensus key gate, not RBAC; no UI caller) | spaces.go:1122-1167,1395; acl.go:64-148 |
| Join community (`POST /spaces/community/join`) | none | Invite-key possession only | Onboarding (`client.ts:206` via `stores/identity.ts`) | 🔶 Frontend-only | spaces.go:852-1025,1393; client.ts:206 |
| Verify access (`GET /spaces/community/verify-access`) | none | none (read; checks backend's own space key first at 1065-1079, then the supplied aid's peer key — on the owner's backend any aid reports access) | `client.ts:184` | ⚠️ Policy not enforced (open read) | spaces.go:1036-1106,1394; client.ts:184 |
| Grant steward Admin (`POST /spaces/grant-steward-admin`) | none | **No HTTP auth**; consensus rejects if backend not owner — but on the owner's machine any local caller succeeds | Steward-upgrade admin flow (`useAdminActions.ts:591`, `client.ts:484`) | 🔶 Frontend-only (admin-power endpoint, no HTTP auth; consensus gates only the backend's key) | spaces.go:1180-1252,1396; acl.go:260-309; useAdminActions.ts:584-591 |
| Get user spaces (`GET /spaces/user`) | none | none (read) | `client.ts:166` (via `stores/identity.ts:359`) | ⚠️ Policy not enforced (open read) | spaces.go:131-217,1398 |
| Sync status (`GET /spaces/sync-status`) | none | none (read) | Onboarding (`client.ts:542`, `components/onboarding/WelcomeOverlayScreen.vue:285`) | ⚠️ Policy not enforced (open read) | spaces.go:1280-1387,1399 |
| Sync credentials (`POST /sync/credentials`) | none | none — validates struct, caches to own space | `client.ts:76`, `useCredentialPolling.ts:784` | 🔶 Frontend-only | sync.go:109-230,529 |
| Sync KEL (`POST /sync/kel`) | none | none | **no frontend caller found** (no wrapper in `client.ts`) | ⚠️ Policy not enforced (no gate, no live caller) | sync.go:234-330,530 |
| Community members (`GET /community/members`) | none | none (read) | wrapper exists (`client.ts:93`) but no UI consumer found — roster UI uses `/api/v1/members/` instead | ⚠️ Policy not enforced (open read) | sync.go:332-424,533 |
| Community credentials (`GET /community/credentials`) | none | none (read) | **no frontend caller found** | ⚠️ Policy not enforced (open read) | sync.go:426-524,534 |
| Trust graph (`GET /trust/graph`) | none | none (read) | none found — API exists but no live UI caller outside the `client.ts:134` wrapper | ⚠️ Policy not enforced (open read) | trust.go:99-154,275 |
| Trust score (`GET /trust/score/{aid}`) | none | none (read) | `client.ts:143` wrapper, no UI consumer found | ⚠️ Policy not enforced (open read) | trust.go:156-202,276 |
| Trust scores / summary (`GET /trust/scores`,`/summary`) | none | none (read) | none found | ⚠️ Policy not enforced (open read) | trust.go:208-271,277-278 |
| Get org config (`GET /org/config`) | none | none (read) | `api/config.ts:111` | ⚠️ Policy not enforced (open read) | org.go:124-144,217 |
| Save org config (`POST /org/config`) | none | **none** | Setup flow only (`useOrgSetup.ts:264` → `config.ts:183`) | 🔶 Frontend-only (admin-power, no auth) | org.go:147-199,227; useOrgSetup.ts:264; config.ts:183 |
| Delete org config (`DELETE /org/config`) | none | **none** (test helper) | none | ⚠️ Policy not enforced | org.go:239-264,229 |
| Org health (`GET /org/health`) | none | none (returns ok) | health checks (`config.ts:283`) | ⚠️ Policy not enforced (open read) | org.go:202-213,218 |
| Multisig rotation-signal (`POST /multisig/rotation-signal`) | none | none — writes to community space with backend key | `lib/keri/client.ts:1360` | 🔶 Frontend-only | multisig.go:49-100,33 |
| Multisig rotation-ack (`POST /multisig/rotation-ack`) | none | none | `useMultisigRotationSignal.ts:90` | 🔶 Frontend-only | multisig.go:114-157,34 |
| Comment cursors (`GET`/`PUT /comment-cursors`) | none | Scoped to local identity's own private space (self-scoping by construction, not a role check) | `commentCursors.ts:11,25` | 🔷 Backend-only (self-scoped, not RBAC) | comment_cursors.go:42-194 |
| List/get types (`GET /types`,`/types/{name}`) | none | none (read) | `client.ts:329,343` → `stores/types.ts:14` | ⚠️ Policy not enforced (open read) | profiles.go:44-79,969-970 |

### Notes & Gaps

- **No endpoint in this whole area is RBAC-gated.** `RequireAction`/`RBACMiddleware` appear only in `milestones.go`, `contributions_handler.go`, `proposals.go`, `projects.go`, `decision_plans.go` (and `rbac.go` itself). Everything covered here mounts unwrapped handlers or `CORSHandler`-wrapped ones — CORS headers only, no auth (verified via grep + each `RegisterRoutes`). Authorization is delegated entirely to (a) the any-sync consensus node for ACL mutations, and (b) `LocalhostGuard` at the network edge in bundled mode (`cmd/server/main.go:761`).
- **`X-User-AID` is never cryptographically verified** (`rbac.go:31`). Even the RBAC-gated endpoints elsewhere trust the header verbatim; these endpoints don't read it at all. Spoofing the header buys nothing *here* because roles aren't consulted, but it means the model is "trust the localhost caller," not "authenticate the user."
- **`POST /api/v1/org/config` is an unauthenticated privilege-escalation surface.** The written `Admins` list is consumed by `OrgConfigAdminLookup.GetUserRoles`, which maps any listed AID to **Founding Member** (`rbac.go:112-122`, mapping at 119), the role that satisfies the RBAC-gated project/contribution actions. A caller who can reach the port (dev/test: any origin; bundled: localhost) can add their own AID as an admin and thereby unlock every RBAC-gated write elsewhere in the app. There is no setup-time lock, no "already configured" guard, and no owner check — POST silently overwrites the entire config (`org.go:177-181`).
- **`DELETE /api/v1/org/config` is exposed in all environments,** not just tests, despite its "Used by tests" comment (`org.go:237-238`). Deleting the config wipes org identity + space IDs with no auth (`org.go:239-264`).
- **`grant-steward-admin` has no HTTP auth** — it relies solely on the consensus node rejecting a `PermissionChange` not signed by the space owner. The handler's own doc-comment states this ("Only the space owner can call this successfully — the SDK enforces it at the consensus layer", `spaces.go:1188-1189`). Crucially, the consensus check authenticates the *backend's key*, not the HTTP caller: on the owner's machine any local process can trigger the elevation. If a non-owner backend calls it, it gets a 500/consensus error, not a 403, so the failure mode is opaque. The frontend only invokes it inside the Founding-Member steward-upgrade flow (`useAdminActions.ts:591`), so the UI *looks* gated, but the endpoint is not.
- **`community/invite` similarly leans on consensus, not RBAC.** It will only succeed for a backend holding the community space's Admin key. This is why the steward-upgrade flow calls `grantStewardAdmin` *before* the steward can create invites (`useAdminActions.ts:584-590` comment). Correct behavior, but entirely emergent from key possession, not from a policy table — and again, any local caller on a key-holding backend can mint invites.
- **`GetPermissionsForRole` (`keri/client.go:146-165`) is decorative.** Its only consumer is `HandleRoles` (`credentials.go:228-246`, call at `:240`), which serves GET `/api/v1/credentials/roles` — a role→permission-strings listing for display. No middleware or handler ever *reads* those permission strings ("read", "vote", "admin", …) to make an access decision. Its Title-Case role names ("Financial Steward", "Governance Steward", "Cultural Steward", "Technical Steward") are the KERI credential vocabulary — `MapKERIRole` (`contributions/roles.go:23-48`) does still map them into the canonical 10-role set — but the permission strings themselves connect to nothing.
- **The policy table in `contributions/roles.go` contains no space/sync/trust/org/multisig actions** — there are no `ActionCreateSpace`, `ActionGrantAdmin`, `ActionEditOrgConfig`, etc. So these operations are not even "allRoles" entries; they simply don't exist in the RBAC model. Any doc claiming a role gate on space/admin operations is 📄 Documented only.
- **Trust graph endpoints have no live frontend consumer** — `getTrustGraph`/`getTrustScore` exist only as thin wrappers (`client.ts:134,143`) with no page/component caller. The data (who trusts whom, credential-derived scores) is fully readable by any caller with no auth — a visibility gap if trust data is meant to be sensitive. The same is true of `GET /community/credentials` and `POST /sync/kel` (no frontend callers at all) and `GET /community/members` (wrapper unused; roster UI reads `/api/v1/members/` from profiles.go instead).
- **Design doc drift (`docs/design/PROJECTS_CONTRIBUTIONS_DOCUMENTATION.md` §6):** the doc's role vocabulary (`community_admin`, `project_lead`, `project_steward`, `contributor`, `member` — lines 905-909) predates the current 10-role KERI set and says nothing about spaces, sync, org config, or admin-space access. Section 6 is a contributions-only matrix; it does not document that the entire infrastructure layer is unauthenticated. `docs/plans/2026-02-22-role-based-membership-design.md` contains no "space" references at all.
- **Admin space (`SpaceTypeAdmin`) is created and its ID is surfaced (`spaces.go:451-482`, `api/identity.go:313`) but no read/write endpoint in this area gates on it.** Its ACL is owner-only (`acl.go:513-522` `AdminACL` → `PermissionNone` default), so protection is again consensus-key possession, not application logic. `ACLPolicyForSpaceType` (`acl.go:524-538`) and `ValidateAccess`/`GrantAccess`/`RevokeAccess` (`acl.go:449-502`) exist but are the older `ACLManager` path — `GrantAccess`'s own comment calls it "the legacy AddToACL path" (`acl.go:477`) — while the live invite/join flow uses `MatouACLManager` (`CreateOpenInvite`/`JoinWithInvite`), so those policy-evaluation helpers are largely parallel/unused for the community flow.

---

## Appendix: Known Gaps & Design-Doc Drift

Compiled from the per-area research; each item was verified against code by a reviewer agent.


### Role Model & Resolution

- PUT /api/v1/members/{aid}/role has NO backend auth at all (no RBAC, no X-User-AID) — any local caller can set any member to Founding Member (profiles.go:666-778, routed profiles.go:975)
- DELETE /api/v1/members/{aid} and POST /api/v1/profiles/init-member equally unauthenticated; init-member takes the role verbatim from the request body (profiles.go:388-457, 785+)
- X-User-AID header is client-supplied with zero cryptographic verification (rbac.go:31); only mitigation is LocalhostGuard in bundled mode (middleware.go:195-218)
- Any AID string resolves to at least the member role (role_store.go:70-72), and most actions are allRoles — invented AIDs pass most RequireAction gates
- 3 of 4 RoleLookup chain links (OrgConfigAdminLookup, CredentialRoleLookup, IdentityRoleLookup) are unreachable dead code because ProfileRoleLookup never returns empty/error (main.go:521, rbac.go:204-215)
- CredentialRoleLookup ignores the Verified/issuer flag (rbac.go:144-164); combined with unauthenticated POST /api/v1/credentials this becomes role escalation if the chain is ever reordered
- GetPermissionsForRole permission strings are decorative — single call site is the informational GET /api/v1/credentials/roles, which the frontend never calls (credentials.go:240)
- elder_council role is ungrantable (no MapKERIRole case, no endpoint assigns it); tech_steward and treasury_steward have no restricted actions and are functionally identical to member
- Design doc drift: PROJECTS_CONTRIBUTIONS_DOCUMENTATION.md sec 6 claims admin-only Create Project etc. but code has allRoles (roles.go:115); 2026-02-22 plan says role update revokes+reissues the credential and is Ops-Steward/Founding-only — neither is implemented; frontend gates role change with broader isSteward instead of canManageMembers (DashboardPage.vue:219)
- Frontend admin detection is substring-based (role contains steward/admin/founding, identity.ts:250) and diverges from backend policy for edge roles like Cultural Steward

### Projects

- X-User-AID header is trusted verbatim with no cryptographic verification (rbac.go:31); spoofing a config-admin AID grants Founding Member roles
- Any unknown AID defaults to the member role (role_store.go:70-72), making every allRoles action — create/edit/delete project, assign-role — effectively open to anyone
- create_project is allRoles in code (roles.go:115) but admin-only in design doc §6.2 and in the UI — the admin restriction is frontend-only
- Backend RBAC checks global roles only; no backend verification that the caller is the specific project's lead/steward (archive, submit/approve/reject completion) — per-project checks are frontend-only by design (roles.go:98-99 comment)
- SubmitProjectCompletion's leadID parameter is unused (service.go:2597) — no lead binding; RejectProjectCompletion never records who rejected; a steward can approve a completion they submitted
- DELETE /api/v1/projects/{id} is live and open to any member-role AID but has no UI caller; the UI 'Delete Project' button actually archives
- GET project list/detail/contributions/comments require no auth header at all — fully open to anonymous callers, including budget and rejection-reason fields
- assign-role endpoint reuses ActionCreateProject (allRoles) instead of a dedicated action (projects.go:70); UI-only admin restriction
- link-proposal endpoint has no RBAC middleware at all (projects.go:80-86)
- Project comment POST takes user_id/user_name from the request body — authorship is caller-asserted (projects.go:432-452)
- elder_council role is defined but unreachable — MapKERIRole never emits it
- keri.GetPermissionsForRole is a decorative parallel permission list — only call site is the informational GET /api/v1/credentials/roles response (credentials.go:240)
- Frontend dead code: canRejectProjectCompletion and canDeleteProject computed properties are exported but never used by any component
- Design doc §6.1 5-role model does not match the 10-role code model in contributions/roles.go

### Contributions Lifecycle

- X-User-AID header is trusted verbatim (rbac.go:31) — no cryptographic verification; every backend RBAC check is impersonatable
- POST /contributions/{id}/transition has no RBAC and can set signed_off/rewarded, bypassing the only role-restricted contribution actions (contributions_handler.go:84-90)
- Implementation-plan sign-off route has no RBAC middleware and accepts user_id from body despite restricted ActionSignOffPlan policy (implementation_plans.go:60-63,149-163)
- POST /api/v1/contributions (create, incl. subs), PUT edit, /assign, /register, /comments have no backend role check; ActionCreateContribution/ActionCreateSubContrib/ActionAssignContribution/ActionRegisterInterest exist in the policy table but are never wired
- Most wired actions (confirm, share, offer, submit-evidence, review, approve-sub) are allRoles — backend check degrades to 'has any community role'; roles.go:98-99 documents frontend delegation as intentional
- Backend role checks are community-global, never project-scoped — any project_steward can sign off contributions on any project; per-project lead/steward matching is frontend-only
- SubmitEvidence does not verify the caller is the assigned contributor (service.go:1755-1815)
- shared_with_roles is stored and displayed but never filters visibility anywhere — sharing-targeting is decorative; all contributions (incl. unshared, budgets, evidence) readable via unauthenticated GETs
- Budget visibility (useContributionBudgetAccess) and admin-only private-offer visibility (contributionsView.ts:90-103) are client-side cosmetic filters over fully-delivered data
- elder_council role is defined but unreachable — no MapKERIRole branch grants it (roles.go:23-48)
- Frontend drift: useContributionWorkflow.canApproveSub (lead/admin) vs ContributionDetailBody.vue:1264 (lead/steward/admin)
- Design doc PROJECTS_CONTRIBUTIONS_DOCUMENTATION.md §6 matrix presents UI-layer gating as enforced access control and contradicts code on register-interest, submit-evidence, and create-contribution; reward/archive/unassign/transition absent from doc
- keri.GetPermissionsForRole permission strings are decorative — only call site is the display-only GET /api/v1/credentials/roles (credentials.go:240)
- Comments accept arbitrary user_id/user_name from request body — spoofable attribution (contributions_handler.go:1021-1054)

### Plans, Milestones & Governance Actions

- Implementation-plan routes registered with NO RBAC middleware (main.go:607): create/list/get/add-milestone/sign-off all callable without X-User-AID
- Plan sign-off ignores the restricted sign_off_plan policy and even accepts user_id from the request body (implementation_plans.go:155-163) — anonymous callers can sign off any plan as any AID
- Governance-action endpoints (complete/archive/vote/resolve) have no middleware and no role checks (decision_plans.go:68-94)
- Voting has no house-membership or eligibility model anywhere; any AID can cast Elder Council veto votes, and duplicate-vote protection keys on the spoofable X-User-AID header (service.go:1082-1128)
- Decision-plan sign-off steward match accepts the spoofable X-User-Name header (decision_plans.go:165-167)
- Milestone edit/archive RBAC is global, not project-scoped — e.g. a Technical Steward credential (maps to project_lead) can edit any project's milestones; per-project matching is frontend-only (roles.go:98-99 admits this)
- X-User-AID is never cryptographically verified (rbac.go:31), and IdentityRoleLookup grants Founding Member to the backend owner's own AID (rbac.go:186-192), so the local user passes every RequireAction check
- Add-milestone has no Action constant or backend check while edit/archive-milestone are RBAC-gated — inconsistent coverage on the same data
- All plan/decision-plan GETs are unauthenticated, exposing budgets the UI's canSeeContributionBudget gate pretends to hide
- elder_council role is defined but never granted by MapKERIRole and never checked
- KERI GetPermissionsForRole strings (vote/propose/manage_governance) are decorative — only echoed in credentials.go:240, never enforced
- Design doc PROJECTS_CONTRIBUTIONS_DOCUMENTATION.md (lines 384-405) still shows legacy client-side-only sign-off; its role claims describe UI intent, not enforcement
- Frontend isSteward (role string contains 'steward') is broader than backend sign_off_plan roles — Treasury Steward passes UI gate but fails backend decision-plan sign-off

### Proposals & Endorsements

- X-User-AID / X-User-Name are plain unverified headers — all proposal enforcement is spoofable (rbac.go:31, proposals.go:235,258,399)
- Transition endpoint only guards rejected/signed_off/withdrawn — anyone (even anonymous) can approve: signed_off→voting_process→approved→completed and draft→submitted are unchecked (proposals.go:191-269)
- Privilege escalation: unauthenticated PATCH of proposal_steward_id (isRoleClaimOnly exemption, proposals.go:105-114) satisfies the assigned-steward branch of the sign-off check (proposals.go:236-237)
- Endorsements unauthenticated and endorser_id body-supplied — self-endorsement rule spoofable; fake endorsements auto-advance proposal to in_review (proposals.go:328-333, service.go:362-395)
- Proposal detail/endorsements/history/comments readable with no auth (OptionalRBACMiddleware, proposals.go:54); no draft privacy — all users see all drafts (ProposalsPage.vue:175-189)
- Edit permission check only fires for in_review status — draft/submitted/endorsing content edits unrestricted server-side (proposals.go:393)
- Frontend isSteward is a substring match ('steward'/'founding member', identity.ts:47-50) — Tech/Treasury/Financial stewards see Sign Off/Reject buttons that 403 on the backend
- RequireAction middleware never used on proposal routes — all checks hand-rolled in handlers
- elder_council role unreachable: no MapKERIRole mapping and absent from every proposal action list (roles.go:18,23-48,133-136)
- KERI GetPermissionsForRole 'propose' string (stewards only) is decorative — only embedded in credential data (credentials.go:240), never consulted; every member can create proposals
- Design-doc drift: PROJECTS_CONTRIBUTIONS_DOCUMENTATION.md:1886 expects Create Proposal hidden from members, but the button is shown to everyone (ProposalsPage.vue:8); doc section 6 RBAC matrix omits proposals entirely
- Proposal comments accept arbitrary body-supplied user_id/user_name with no auth (proposals.go:446-482)

### Membership, Registration & Credentials

- PUT /api/v1/members/{aid}/role has zero backend authorization (profiles.go:668-778) despite design doc restricting it to Operations Steward/Founding Member (2026-02-22-role-based-membership-design.md:70)
- DELETE /api/v1/members/{aid} has zero backend authorization (profiles.go:787-907); design doc 2026-02-24-admin-member-removal-design.md specified canManageMembers-only
- canManageMembers (Ops Steward/Founding Member) computed in identity.ts:52-55 is never used for gating — UI gates Change Role/Remove Member on the broader isSteward (any steward type) at DashboardPage.vue:219-220
- Latent privilege escalation: POST /api/v1/credentials stores unverified credentials (no signature check, keri/client.go:105-127) and CredentialRoleLookup (rbac.go:136-166) maps the role field without checking issuer/Verified. As currently wired this lookup is shadowed by ProfileRoleLookup (which always resolves at least `member`), so the operative escalation path is the unauthenticated PUT /api/v1/members/{aid}/role — but the credential-cache weakness becomes live if the lookup chain is ever reordered
- X-User-AID header has no cryptographic verification (rbac.go:29-46); backend explicitly has no authentication layer (middleware.go:190-193), LocalhostGuard active only in bundled mode
- Non-steward role changes update CommunityProfile only — no credential revoke/reissue (ChangeRoleModal.vue:239-263), diverging from design and leaving credential role stale
- keri.GetPermissionsForRole permission strings are decorative — sole call site is informational GET /api/v1/credentials/roles (credentials.go:236-244), never consulted for enforcement
- elder_council role defined (roles.go:18) but unreachable — MapKERIRole never produces it
- GET /api/v1/credentials returns all cached credentials to any unauthenticated caller (credentials.go:296-330)
- Removed/declined members filtered client-side only (DashboardPage.vue:684); backend profile list returns them
- Approval prerequisites (>=1 endorsement + attendance) enforced only in ProfileModal.vue:475-479 — bypassable by direct API/KERIA calls
- POST /api/v1/profiles/init-member and POST /api/v1/spaces/community/invite are unauthenticated; real backstop is any-sync ACL Admin permission and KERIA org-key possession, not app-layer RBAC

### Communication & Content (Notices, Chat, Events, Files)

- No comms endpoint (notices, chat, files, invites, booking, SSE) is wired through RBACMiddleware/RequireAction; no Action constants exist for this domain in contributions/roles.go — all steward gating is UI-only v-if isSteward
- Comms handlers never read X-User-AID; authorship comes from the local backend identity, so the only boundary is LocalhostGuard (bundled mode only, middleware.go:195) — dev/test API is open to any network caller
- Chat AllowedRoles enforcement is a TODO stub (getUserRole() returns "" at chat.go:1776) — role-restricted channels are hidden from everyone including stewards
- Chat messages endpoints (HandleListMessages/HandleGetThread) never check channel AllowedRoles — restricted-channel messages readable by anyone with the channel ID
- SSE /api/v1/events streams full chat message content and notice events to any unauthenticated subscriber (events.go:78)
- POST /api/v1/invites/send-email is an unauthenticated open relay for the org SMTP sender (no role check, no rate limit, invites.go:39)
- Attendance credential issuance: design doc says admin/steward hosts, but code only requires holding any membership credential (client-side check, useEventAttendance.ts:85-94); steward restriction is a v-if in ProfileModal.vue:240
- Invite initial-role selection is steward-gated only in the UI (InviteMemberModal.vue:41); nothing server-side enforces which role an inviter may pre-assign
- GetPermissionsForRole() in keri/client.go is decorative — only call site is the informational GET /api/v1/credentials/roles listing (credentials.go:240); its moderate/comment/admin strings are never consulted
- Notice RSVP capacity (rsvpCapacity) is stored but never enforced (notices.go:494-557)
- File upload/download unrestricted beyond 20MB cap and CID validity; downloads served with public immutable cache headers (files.go:170-172)
- Chat message edit/delete ownership is the only enforced rule in the area, but it compares against local backend identity — per-honest-node convention, not cryptographic; a modified peer could forge edits into the shared tree

### Spaces, Sync & Admin Infrastructure

- POST /api/v1/org/config is unauthenticated and its Admins list maps callers to Founding Member (rbac.go:112-122) — anyone reaching the port can self-escalate to unlock all RBAC-gated actions app-wide
- DELETE /api/v1/org/config is exposed in all environments (not test-only despite its comment) with no auth — wipes org identity + space IDs (org.go:238-264)
- No endpoint in the spaces/sync/trust/org/multisig/comment-cursors/types area is wired through RequireAction/RBACMiddleware — zero application-layer RBAC across the entire infrastructure layer
- grant-steward-admin (admin-power ACL elevation) has no HTTP auth; relies entirely on any-sync consensus rejecting non-owner signatures, so failures surface as 500s not 403s (spaces.go:1180-1252)
- community/invite and community-readonly/invite have no HTTP auth; gated only by possession of the space Admin key at consensus layer (spaces.go:719-834; acl.go:64-148)
- X-User-AID header is never cryptographically verified (middleware.go, rbac.go:31); these endpoints don't read it, so the only real guard is LocalhostGuard in bundled mode
- Trust graph/score/summary endpoints are fully readable with no auth and no visibility gate; no live frontend consumer found (trust.go:274-279)
- GetPermissionsForRole (keri/client.go:146) is decorative — its only call site is the display-only GET /api/v1/credentials/roles listing (credentials.go:240); it is never consulted for access decisions, and its permission strings are never enforced anywhere
- contributions/roles.go policy table contains NO space/sync/org/admin/multisig Action constants — these operations are entirely outside the RBAC model, not even allRoles entries
- join community requires only a valid base64 invite key with no role/identity check (spaces.go:852-1025)
- Design doc PROJECTS_CONTRIBUTIONS_DOCUMENTATION.md section 6 uses obsolete role names and documents no infrastructure-layer enforcement; membership-design plan has zero space references

