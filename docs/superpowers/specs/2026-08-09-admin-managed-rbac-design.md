# Admin-Managed RBAC — Design

**Status:** Approved design, pre-implementation.
**Date:** 2026-08-09
**Depends on:** issue #6 (backend RBAC wiring) as a hard prerequisite. Complements #5. Forward-compatible with #8/#9.
**Background:** `docs/RBAC.md` (2026-08-06 audit) — today the role/permission model is hardcoded (`backend/internal/contributions/roles.go`), largely unenforced, and role assignment endpoints have no auth.

## Goal

Community admins manage RBAC through the UI: edit what each role can do, assign roles to members, and create custom roles — with one policy governing every member's backend.

## Decisions (settled during brainstorming)

1. **Scope:** permission-matrix editing + role assignment + custom roles backed by KERI credentials.
2. **Who manages:** a `manage_roles` meta-permission in the matrix itself. Defaults to Founding Member + Operations Steward. Org-config admins always retain it (code-enforced backstop; prevents lockout).
3. **Trust level:** API-layer enforcement first (each member's backend obeys the policy; builds on #6). The policy object is designed so peer-side validation (#8) and KERI-signed changes (#9) can adopt it later without redesign.
4. **Granularity:** ~11 grouped capabilities, each mapping to a fixed set of backend Action constants. No raw per-action editing in v1.
5. **Scoping:** global grants only in v1. Per-project binding ("lead of THIS project") remains the small hardcoded resource-check set from #6.
6. **Policy location:** a versioned synced object in the community-readonly space (Option A; alternatives rejected: org-config extension — wrong distribution model, per-deployment not community-synced; local-store-only — no propagation, each backend would configure only itself).

## 1. Data model — the `RolePolicy` object

A single object of new type `RolePolicy` in the **community-readonly space** (alongside profiles), one per community.

```
RolePolicy {
  version:   int      // monotonic; optimistic concurrency + audit
  updatedBy: string   // editing admin's AID
  updatedAt: string   // RFC 3339
  roles: [            // role registry
    { id: string,           // snake_case; doubles as the credential role string
      displayName: string,
      builtin: bool }       // the 10 existing KERI roles ship as builtin
  ]
  grants: { roleId: [capabilityId] }   // the editable matrix
}
```

- Capabilities are **not** stored in the document — they are a fixed registry in code (§2). The policy records only who holds which capability.
- Code ships a **default policy** exactly equivalent to today's `actionPermissions` + `MapKERIRole` tables. It applies when no `RolePolicy` object exists (fresh org, first boot, corrupt object). Behavior changes only when an admin first edits.

## 2. Capability registry (fixed, in code)

One Go file maps each capability to its backend Action constants (including the new constants #6 introduces). This file is the single place a new endpoint gets classified.

| Capability | Covers |
|---|---|
| `contribute` | create contribution/sub-contribution, register interest, offer, submit evidence |
| `manage_projects` | create/edit/archive project, milestones, assign project lead/steward |
| `assign_work` | assign/unassign contributors |
| `review_work` | review submissions, approve sub-contributions |
| `sign_off` | contribution sign-off, decision/implementation plan sign-off |
| `reward` | reward contributions |
| `approve_completion` | project completion approve/reject |
| `manage_members` | init-member, change member role, remove member |
| `manage_governance` | proposal sign-off/reject/edit/withdraw, governance actions |
| `manage_communications` | notices publish/archive/pin, chat channel create/edit/archive |
| `manage_roles` | **meta-permission**: edit the matrix, create/deactivate custom roles |

Read/view actions stay open to all members in v1 (not capability-gated).

Note: `manage_communications` maps to Action constants that do not exist yet — notices/chat routes are outside #6's scope (they are the follow-up ticket from #6's vetting). The capability ships in the registry from day one, but enforces nothing until those routes are wired; the matrix column is displayed regardless so grants can be configured ahead of enforcement.

## 3. Enforcement path (backend)

- `CanPerformAction(roles, action)` consults a new **`PolicyProvider`** instead of the static table: action → capability (registry) → grants (cached `RolePolicy`), falling back to the built-in default policy when none is synced.
- The provider's cache is kept fresh by the existing tree-listener machinery on the community-readonly space (same mechanism as profiles).
- **Endpoints:**
  - `GET /api/v1/role-policy` — any member; returns the effective policy (synced or default) plus the capability registry for UI rendering.
  - `PUT /api/v1/role-policy` — requires `manage_roles`; body carries `version`; mismatch → 409.
- **Sync-layer alignment:** the community-readonly space is writable only by the org owner and `grantStewardAdmin`-elevated stewards, so sync-layer write control approximates "admins"; the precise `manage_roles` check sits on top at the API layer. Granting `manage_roles` to a steward role triggers the same `grantStewardAdmin` elevation flow init-member already requires (`useAdminActions.ts:585-591` precedent).

## 4. Custom roles + KERI credentials

- Creating a custom role (e.g. `kaitiaki`) appends it to the registry with an empty grant set.
- Assignment reuses the existing membership-credential machinery unchanged: the credential's `role` field carries the custom role id. **No new credential schema.**
- `IsValidRole` becomes policy-aware — valid = built-in 10 + registry entries — replacing the hardcoded `ValidRoles()` check (`keri/client.go:184-191`, used at `profiles.go:691`).
- `MapKERIRole`'s hardcoded expansion is replaced by the policy: built-in roles keep their current bundles (encoded in the default policy's grants); custom roles grant exactly what the matrix says.

## 5. UI

- New **Roles & Permissions** admin page, visible with `manage_roles`: roles as rows, capabilities as columns, toggle cells; "New role" dialog (name + optional copy-grants-from role); save PUTs with current version and surfaces 409 conflicts by reloading.
- ChangeRoleModal's role list becomes policy-driven (registry instead of hardcoded 10).
- Frontend permission gating (`useProjectPermissions`, `useAdminAccess`) migrates from `isAdmin`/`isSteward` substring heuristics to a policy store fed by `GET /role-policy`. v1 migrates the gates the audit flagged as drifted; the rest follow incrementally.

## 6. Safety & failure modes

- **Lockout prevention:** org-config admins always hold `manage_roles`, enforced in code — not expressible or removable in the matrix. The UI additionally refuses to remove `manage_roles` from the last role holding it.
- **Concurrent edits:** version mismatch → 409 → UI reloads latest matrix.
- **Missing/corrupt policy object:** fall back to built-in defaults and log loudly. Never fail open to "no policy".
- **Deleting custom roles:** deletable only when no member credential carries the role (backend checks profiles); otherwise **deactivate** — unassignable to new members, existing holders keep resolving until reassigned.

## 7. Testing

- **Backend unit:** PolicyProvider fallback; action→capability→grant resolution; version conflict; backstop invariance (org-config admin keeps `manage_roles` regardless of policy content); policy-aware `IsValidRole`.
- **Integration:** policy edit → enforcement changes on next request; custom role end-to-end (create → grant capability → issue credential → member performs newly allowed action; denied after grant removed).
- **E2E (Playwright):** admin edits matrix in UI; second user's available actions change after sync.

## 8. Sequencing

1. **#6 lands first** — a dynamic policy is meaningless while routes bypass `RequireAction`.
2. This feature: backend PolicyProvider + endpoints + default policy → custom-role plumbing (`IsValidRole`, role registry) → UI.
3. Later, without redesign: #8's peer-side validator consults the same synced `RolePolicy` as its rule source; #9 makes policy edits KERI-signed; per-capability scoping (per-project) extends the grant entries.
