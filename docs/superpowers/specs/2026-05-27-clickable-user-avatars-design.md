# Clickable User Avatars + AssignmentCard Avatar — Design

**Date:** 2026-05-27
**Status:** Draft

## Problem

1. The contributions `AssignmentCard` shows "Assigned to {name}" / "Offered to {name}" as text only — no avatar.
2. Avatars are rendered ad-hoc in ~20 places across the app with no shared component. There is no consistent way to go from "I see this person's avatar" to "show me their profile." A `ProfileModal` exists but is wired only into `DashboardPage` (the members list) and is registration/steward-oriented.

## Goals

- Add the profile avatar before the name in the `AssignmentCard` assigned/offered/read-only lines.
- Introduce one shared `UserAvatar` component and use it for every standard user avatar in the app.
- Clicking any such avatar opens a read-only profile dialog for that user — **except** on the profile page (AccountSettingsPage) and the members list (DashboardPage), where avatars stay non-interactive so existing behavior is preserved.
- Clicking your own avatar opens the same read-only dialog (no special-casing).

## Non-goals

- Reworking `ProfileModal`'s internals or its steward/registration flows.
- Making the wallet trust-graph issuer nodes clickable (specialized visualization — out of scope).
- Changing the `DashboardLayout` sidebar "View Profile" button (a deliberate nav-to-settings control, not a display avatar).
- Backend changes — this is frontend-only. Profile data is already available client-side.

## Architecture

Three new/changed pieces:

### 1. `UserAvatar.vue` (new shared component)

Location: `frontend/src/components/profiles/UserAvatar.vue`

**Props:**
```ts
interface Props {
  aid?: string;          // when set, name/avatar resolve from the profiles store
  name?: string;         // override (non-member / registration contexts with no store entry)
  src?: string;          // override avatar source (raw ref, http URL, or data URI)
  size?: number;         // px diameter, default 32
  clickable?: boolean;   // default true; click opens the profile viewer when an aid is known
}
```

**Behavior:**
- Display name: `name` prop if given, else `profilesStore.profilesByAid[aid]?.displayName`, else `aid.slice(0,12) + '…'`, else `''`.
- Avatar source: `src` prop if given, else `profilesStore.profilesByAid[aid]?.avatar`. Resolve to a URL: if it starts with `http`/`data:` use as-is, otherwise `getFileUrl(ref)`. On `<img>` error, fall back to initials.
- Initials: first letters of the first two name words, uppercased; single word → first two chars.
- Fallback background: hash the name to pick one of the existing gradient classes (same scheme used in `ProfileModal`), so a given person is always the same color.
- Interactivity: the avatar is clickable only when `clickable !== false` **and** an `aid` is known. On click: `@click.stop` (so it doesn't trigger an enclosing row/card handler) → `profileViewer.open(aid)`. When clickable it shows `cursor: pointer` and a subtle hover affordance.

### 2. `useProfileViewer` store (new)

Location: `frontend/src/stores/profileViewer.ts`

```ts
state:  openAid: string | null
getters: isOpen, sharedProfile (resolved .data by aid), communityProfile (role, by aid)
actions:
  async open(aid: string):
    - if communityProfiles empty → await profilesStore.loadCommunityProfiles()
    - if communityReadOnlyProfiles empty → await profilesStore.loadCommunityReadOnlyProfiles()
    - resolve the SharedProfile payload whose data.aid === aid; if none found, no-op
      (optionally a $q.notify "Profile not available"); otherwise set openAid = aid
  close(): openAid = null
```

`sharedProfile` = `communityProfiles.find(p => p.data.aid === openAid)?.data ?? null`.
`communityProfile` = `communityReadOnlyProfiles.find(p => p.data.userAID === openAid)?.data ?? null`.

### 3. Singleton `ProfileModal` in `DashboardLayout.vue`

Mount exactly one read-only instance bound to the viewer store:

```vue
<ProfileModal
  :show="profileViewer.isOpen"
  :shared-profile="profileViewer.sharedProfile"
  :community-profile="profileViewer.communityProfile"
  @close="profileViewer.close()"
/>
```

No `registration`, `isSteward` defaults false, `canRemoveMember` defaults false → renders read-only ("Member Profile"). All authenticated views live under `DashboardLayout`, so one mount covers the whole app.

## Migration

Replace ad-hoc avatar markup with `<UserAvatar>`. Three buckets:

**A. Migrate → clickable** (`<UserAvatar :aid="…" />`, default clickable):
- `components/contributions/AssignmentCard.vue` — **new**: avatar before the name in the `assigned` / `offered` / `readonly` lines (uses `assignedAid` / `contribution.offered_to`).
- `components/contributions/ContributionDetailBody.vue` — the `assigned-avatar` block.
- `components/projects/ContributionCardCompact.vue`
- `components/contributions/ContributionSlimCard.vue`
- `components/proposals/ProposalDetailModal.vue`
- `pages/ProposalDetailPage.vue`
- `components/proposals/GovernanceActionModal.vue`
- `components/activity/FeedCard.vue`
- `components/activity/CommentSection.vue`
- `components/chat/MessageItem.vue`
- `components/chat/ThreadPanel.vue`
- `pages/Projects/ProjectDetailPage.vue` — lead / steward / assignee avatars.

**B. Migrate → `:clickable="false"`** (presentation only; click has another meaning or is an exception):
- `pages/DashboardPage.vue` — members list (row already opens the rich steward `ProfileModal`).
- `components/projects/AssignRoleDialog.vue` — member picker (row click selects).
- `pages/AccountSettingsPage.vue` — the profile-page exception (own-avatar upload control).
- `components/onboarding/ProfileConfirmationScreen.vue` — onboarding own-profile preview.

**C. Out of scope / keep as-is:**
- `layouts/DashboardLayout.vue` sidebar "View Profile" button — keep nav-to-settings behavior.
- `components/wallet/CredentialsTab.vue` trust-graph issuer/holder nodes — specialized viz.
- `components/profiles/ProfileModal.vue` internal header avatar — it's the dialog itself.
- `components/profiles/TypedDisplay.vue` — generic object renderer; migrate only if it actually renders a user avatar (decide during implementation).
- `components/profiles/ProfileCard.vue` — used by the members list; treat like bucket B (non-clickable) if it renders an avatar, since the card itself is the click target.

Each call site keeps its current size by passing `:size`. Where a site has the avatar ref/name but not an AID (e.g. registration data), pass `:name`/`:src` and the avatar renders non-clickable.

## Edge cases

- **No AID** (non-member, or AID not yet loaded): renders initials/image, not clickable.
- **AID not in `communityProfiles`** when clicked: `open()` no-ops (no empty modal); optional toast.
- **`@click.stop`** prevents avatar clicks from also firing enclosing row/card handlers (important in lists like contributions and the assign picker).
- **Image load failure:** `<img @error>` falls back to initials.

## Testing

- **Unit (vitest-style script in `tests/scripts/`):** `UserAvatar` resolution — name/initials derivation, src resolution (raw ref → `getFileUrl`, http/data passthrough), and that `clickable` is false when no `aid`. (Pure logic extracted into a small helper so it's testable without mounting.)
- **Type check:** `vue-tsc --noEmit` clean for all touched files (no new errors).
- **Manual smoke:** click an assignee avatar in a contribution, a chat message, and a feed card → read-only profile dialog opens; members-list row still opens the steward modal; account-settings avatar is not hijacked; clicking own avatar opens the dialog.
- **Optional e2e:** in `e2e-projects-contributions`, click the assignee avatar on an assigned contribution and assert the profile dialog appears.

## Rollout / risk

- Frontend-only; no migration or backend coupling.
- The shared component reduces avatar logic duplication, so the net change is fewer lines despite touching ~20 files.
- Risk is mostly visual regressions per call site (size/alignment). Mitigated by keeping per-site sizing explicit and reviewing each migration.

## Open questions

None at design time. `TypedDisplay` and `ProfileCard` get a final keep/migrate decision during implementation based on whether they render a user avatar.
