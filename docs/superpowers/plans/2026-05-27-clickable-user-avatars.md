# Clickable User Avatars Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a shared `UserAvatar` component that renders any user's avatar and, when clicked, opens a read-only profile dialog — used everywhere standard avatars appear except the profile page and members list; and show the avatar before the name in the contributions `AssignmentCard`.

**Architecture:** A pure helper (`src/lib/avatar.ts`) holds the testable name/initials/src/gradient logic. `UserAvatar.vue` uses it plus the profiles store to render and, on click, calls a tiny `useProfileViewer` Pinia store. One read-only `ProfileModal` is mounted in `DashboardLayout` and bound to that store, so any avatar click anywhere opens the dialog with no per-page wiring.

**Tech Stack:** Vue 3 / Quasar / Pinia / TypeScript; Vitest for the pure-helper unit test. Frontend-only.

---

## Spec reference

`docs/superpowers/specs/2026-05-27-clickable-user-avatars-design.md` (commit `43c01f7`).

## File map

**Create**
- `frontend/src/lib/avatar.ts` — pure helpers: `avatarInitials`, `avatarGradientClass`, `resolveAvatarSrc`.
- `frontend/tests/scripts/avatar.test.ts` — vitest unit test for the helpers.
- `frontend/src/stores/profileViewer.ts` — `useProfileViewer` Pinia store (open/close + by-AID resolution).
- `frontend/src/components/profiles/UserAvatar.vue` — shared avatar component.

**Modify**
- `frontend/src/layouts/DashboardLayout.vue` — mount singleton read-only `ProfileModal`.
- `frontend/src/components/contributions/AssignmentCard.vue` — avatar before name.
- Clickable migrations: `ContributionDetailBody.vue`, `ContributionCardCompact.vue`, `ContributionSlimCard.vue`, `FeedCard.vue`, `CommentSection.vue`, `MessageItem.vue`, `ThreadPanel.vue`, `ProposalDetailModal.vue`, `GovernanceActionModal.vue`, `ProposalDetailPage.vue`, `ProjectDetailPage.vue`.
- Non-clickable migrations: `DashboardPage.vue` (members), `AssignRoleDialog.vue`, `AccountSettingsPage.vue`, `ProfileConfirmationScreen.vue`.

---

## Task 1: Pure avatar helpers (`src/lib/avatar.ts`)

**Files:**
- Create: `frontend/src/lib/avatar.ts`
- Test: `frontend/tests/scripts/avatar.test.ts`

- [ ] **Step 1: Write the failing test**

Create `frontend/tests/scripts/avatar.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { avatarInitials, avatarGradientClass, resolveAvatarSrc } from '../../src/lib/avatar';

describe('avatar helpers', () => {
  describe('avatarInitials', () => {
    it('uses first letters of first two words', () => {
      expect(avatarInitials('Jane Biddle')).toBe('JB');
    });
    it('uses first two chars for a single word', () => {
      expect(avatarInitials('Tyronne')).toBe('TY');
    });
    it('returns ? for empty', () => {
      expect(avatarInitials('')).toBe('?');
    });
  });

  describe('avatarGradientClass', () => {
    it('is stable for the same name', () => {
      expect(avatarGradientClass('Jane Biddle')).toBe(avatarGradientClass('Jane Biddle'));
    });
    it('returns one of the four gradient classes', () => {
      expect(['gradient-1', 'gradient-2', 'gradient-3', 'gradient-4'])
        .toContain(avatarGradientClass('Anyone'));
    });
  });

  describe('resolveAvatarSrc', () => {
    it('passes through http URLs', () => {
      expect(resolveAvatarSrc('https://x/y.png')).toBe('https://x/y.png');
    });
    it('passes through data URIs', () => {
      expect(resolveAvatarSrc('data:image/png;base64,AAAA')).toBe('data:image/png;base64,AAAA');
    });
    it('returns empty string for empty ref', () => {
      expect(resolveAvatarSrc('')).toBe('');
    });
    it('routes a bare file ref through the resolver', () => {
      expect(resolveAvatarSrc('fileABC', (r) => `/files/${r}`)).toBe('/files/fileABC');
    });
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

```
cd frontend && npx vitest run tests/scripts/avatar.test.ts
```
Expected: FAIL — cannot resolve `../../src/lib/avatar`.

- [ ] **Step 3: Implement the helper**

Create `frontend/src/lib/avatar.ts`:

```ts
// Pure, dependency-free helpers for rendering user avatars. Kept separate from
// the Vue component so the logic is unit-testable without mounting.

const GRADIENTS = ['gradient-1', 'gradient-2', 'gradient-3', 'gradient-4'] as const;

/** Up to two uppercase initials from a display name. '?' when empty. */
export function avatarInitials(name: string): string {
  const trimmed = (name || '').trim();
  if (!trimmed) return '?';
  const parts = trimmed.split(/\s+/);
  if (parts.length >= 2) {
    return (parts[0]!.charAt(0) + parts[1]!.charAt(0)).toUpperCase();
  }
  return trimmed.substring(0, 2).toUpperCase();
}

/** Deterministic gradient class for a name, so a person is always one colour. */
export function avatarGradientClass(name: string): string {
  const hash = (name || '').split('').reduce((acc, c) => acc + c.charCodeAt(0), 0);
  return GRADIENTS[hash % GRADIENTS.length]!;
}

/**
 * Resolve an avatar reference to a usable <img> src.
 * - http(s) URLs and data: URIs pass through unchanged.
 * - empty refs return ''.
 * - bare file refs are routed through `getFileUrl` (injected so this stays pure).
 */
export function resolveAvatarSrc(
  ref: string | undefined | null,
  getFileUrl?: (ref: string) => string,
): string {
  if (!ref) return '';
  if (ref.startsWith('http') || ref.startsWith('data:')) return ref;
  return getFileUrl ? getFileUrl(ref) : ref;
}
```

- [ ] **Step 4: Run it to confirm it passes**

```
cd frontend && npx vitest run tests/scripts/avatar.test.ts
```
Expected: PASS (10 assertions).

- [ ] **Step 5: Commit**

```
git add frontend/src/lib/avatar.ts frontend/tests/scripts/avatar.test.ts
git commit -m "feat(avatar): pure helpers for initials, gradient, src resolution" -m "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Profile-viewer store (`src/stores/profileViewer.ts`)

**Files:**
- Create: `frontend/src/stores/profileViewer.ts`

Context: `useProfilesStore` exposes `communityProfiles` (full `SharedProfile` payloads, each `{ data: {...} }`), `communityReadOnlyProfiles` (full `CommunityProfile` payloads), and the loaders `loadCommunityProfiles()` / `loadCommunityReadOnlyProfiles()`. `SharedProfile.data.aid` is the AID; `CommunityProfile.data.userAID` is the AID.

- [ ] **Step 1: Create the store**

Create `frontend/src/stores/profileViewer.ts`:

```ts
import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { useProfilesStore } from 'stores/profiles';

// App-wide singleton driving the read-only ProfileModal mounted in
// DashboardLayout. Any UserAvatar click calls open(aid).
export const useProfileViewer = defineStore('profileViewer', () => {
  const profilesStore = useProfilesStore();
  const openAid = ref<string | null>(null);

  const isOpen = computed(() => openAid.value !== null);

  const sharedProfile = computed<Record<string, unknown> | null>(() => {
    if (!openAid.value) return null;
    const p = profilesStore.communityProfiles.find((x) => x.data.aid === openAid.value);
    return (p?.data as Record<string, unknown>) ?? null;
  });

  const communityProfile = computed<Record<string, unknown> | null>(() => {
    if (!openAid.value) return null;
    const p = profilesStore.communityReadOnlyProfiles.find(
      (x) => x.data.userAID === openAid.value,
    );
    return (p?.data as Record<string, unknown>) ?? null;
  });

  async function open(aid: string): Promise<void> {
    if (!aid) return;
    if (profilesStore.communityProfiles.length === 0) {
      await profilesStore.loadCommunityProfiles();
    }
    if (profilesStore.communityReadOnlyProfiles.length === 0) {
      await profilesStore.loadCommunityReadOnlyProfiles();
    }
    // Only open if we actually have a profile to show.
    const found = profilesStore.communityProfiles.some((x) => x.data.aid === aid);
    if (found) openAid.value = aid;
  }

  function close(): void {
    openAid.value = null;
  }

  return { openAid, isOpen, sharedProfile, communityProfile, open, close };
});
```

- [ ] **Step 2: Type-check**

```
cd frontend && npx vue-tsc --noEmit 2>&1 | grep "profileViewer" || echo "clean"
```
Expected: `clean`.

- [ ] **Step 3: Commit**

```
git add frontend/src/stores/profileViewer.ts
git commit -m "feat(profiles): profile-viewer store resolving profile by AID" -m "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: `UserAvatar.vue`

**Files:**
- Create: `frontend/src/components/profiles/UserAvatar.vue`

- [ ] **Step 1: Create the component**

Create `frontend/src/components/profiles/UserAvatar.vue`:

```vue
<template>
  <div
    class="user-avatar"
    :class="[gradientClass, { clickable: isClickable }]"
    :style="{ width: size + 'px', height: size + 'px' }"
    role="img"
    :aria-label="displayName || 'avatar'"
    @click="onClick"
  >
    <img
      v-if="src && !imgError"
      :src="src"
      :alt="displayName"
      class="user-avatar-img"
      @error="imgError = true"
    />
    <span v-else class="user-avatar-initials" :style="{ fontSize: Math.round(size * 0.4) + 'px' }">
      {{ initials }}
    </span>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue';
import { useProfilesStore } from 'stores/profiles';
import { useProfileViewer } from 'stores/profileViewer';
import { getFileUrl } from 'src/lib/api/client';
import { avatarInitials, avatarGradientClass, resolveAvatarSrc } from 'src/lib/avatar';

interface Props {
  aid?: string;
  name?: string;
  src?: string;
  size?: number;
  clickable?: boolean;
}
const props = withDefaults(defineProps<Props>(), {
  aid: '',
  name: '',
  src: '',
  size: 32,
  clickable: true,
});

const profilesStore = useProfilesStore();
const profileViewer = useProfileViewer();
const imgError = ref(false);

const resolved = computed(() => (props.aid ? profilesStore.profilesByAid[props.aid] : undefined));

const displayName = computed(() => {
  if (props.name) return props.name;
  if (resolved.value?.displayName) return resolved.value.displayName;
  if (props.aid) return props.aid.slice(0, 12) + '…';
  return '';
});

const src = computed(() => {
  const ref = props.src || resolved.value?.avatar || '';
  return resolveAvatarSrc(ref, getFileUrl);
});

const initials = computed(() => avatarInitials(displayName.value));
const gradientClass = computed(() => (src.value ? '' : avatarGradientClass(displayName.value)));

const isClickable = computed(() => props.clickable && !!props.aid);

function onClick(e: MouseEvent) {
  if (!isClickable.value) return;
  e.stopPropagation();
  void profileViewer.open(props.aid);
}
</script>

<style scoped lang="scss">
.user-avatar {
  border-radius: 9999px;
  overflow: hidden;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  background: var(--matou-secondary);
  color: #fff;
  user-select: none;
  &.clickable { cursor: pointer; }
  &.clickable:hover { box-shadow: 0 0 0 2px var(--matou-accent); }
  &.gradient-1 { background: linear-gradient(135deg, var(--matou-primary), var(--matou-accent)); }
  &.gradient-2 { background: linear-gradient(135deg, var(--matou-accent), var(--matou-chart-2)); }
  &.gradient-3 { background: linear-gradient(135deg, var(--matou-chart-2), var(--matou-primary)); }
  &.gradient-4 { background: linear-gradient(135deg, rgba(30,95,116,0.8), rgba(74,157,156,0.8)); }
}
.user-avatar-img { width: 100%; height: 100%; object-fit: cover; }
.user-avatar-initials { font-weight: 600; line-height: 1; }
</style>
```

- [ ] **Step 2: Lint + type-check**

```
cd frontend && npx eslint src/components/profiles/UserAvatar.vue 2>&1 | tail -5
cd frontend && npx vue-tsc --noEmit 2>&1 | grep "UserAvatar" || echo "clean"
```
Expected: no errors / `clean`. (ESLint may report "no config" — that's a pre-existing repo gap, not this file.)

- [ ] **Step 3: Commit**

```
git add frontend/src/components/profiles/UserAvatar.vue
git commit -m "feat(profiles): shared UserAvatar component (click opens profile viewer)" -m "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Mount singleton ProfileModal in `DashboardLayout.vue`

**Files:**
- Modify: `frontend/src/layouts/DashboardLayout.vue`

- [ ] **Step 1: Read the layout's template end + script imports**

```
grep -n "</template>\|<script setup\|import ProfileModal\|useProfileViewer\|</q-layout>\|router-view" frontend/src/layouts/DashboardLayout.vue | head
```
Note the element that wraps the page content (e.g. closing of `<q-page-container>`/`</template>`).

- [ ] **Step 2: Add the import + store in `<script setup>`**

In `DashboardLayout.vue`'s `<script setup>`, add:

```ts
import ProfileModal from 'src/components/profiles/ProfileModal.vue';
import { useProfileViewer } from 'stores/profileViewer';

const profileViewer = useProfileViewer();
```

- [ ] **Step 3: Mount the modal once, just before `</template>`**

Add immediately before the closing `</template>` of `DashboardLayout.vue`:

```vue
  <!-- App-wide read-only profile viewer, driven by clicks on any UserAvatar -->
  <ProfileModal
    :show="profileViewer.isOpen"
    :shared-profile="profileViewer.sharedProfile"
    :community-profile="profileViewer.communityProfile"
    @close="profileViewer.close()"
  />
```

(If the root has a single element constraint, place it as a sibling inside the existing root wrapper rather than after it. ProfileModal teleports to body, so its DOM position does not matter.)

- [ ] **Step 4: Type-check**

```
cd frontend && npx vue-tsc --noEmit 2>&1 | grep "DashboardLayout" || echo "clean"
```
Expected: `clean`.

- [ ] **Step 5: Commit**

```
git add frontend/src/layouts/DashboardLayout.vue
git commit -m "feat(profiles): mount singleton read-only ProfileModal in layout" -m "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Avatar before name in `AssignmentCard.vue`

**Files:**
- Modify: `frontend/src/components/contributions/AssignmentCard.vue` (template lines ~42-83)

Context: the script already computes `assignedAid` and `assignedName`; offered recipient is `contribution.offered_to` / `recipientName`. Add `UserAvatar` before the name in the `offered`, `assigned`, and `readonly` branches.

- [ ] **Step 1: Import UserAvatar**

In `AssignmentCard.vue` `<script setup>`, add with the other imports:

```ts
import UserAvatar from 'src/components/profiles/UserAvatar.vue';
```

- [ ] **Step 2: Offered branch — avatar before recipient name**

Replace:

```vue
        <div class="card-title">
          Offered to {{ recipientName }} — awaiting acceptance
        </div>
```

with:

```vue
        <div class="card-title title-with-avatar">
          <UserAvatar :aid="contribution.offered_to" :name="recipientName" :size="20" />
          <span>Offered to {{ recipientName }} — awaiting acceptance</span>
        </div>
```

- [ ] **Step 3: Assigned branch — avatar before assignee name**

Replace:

```vue
        <div class="card-title">Assigned to {{ assignedName }}</div>
```

with:

```vue
        <div class="card-title title-with-avatar">
          <UserAvatar :aid="assignedAid" :name="assignedName" :size="20" />
          <span>Assigned to {{ assignedName }}</span>
        </div>
```

- [ ] **Step 4: Read-only branch — avatar before name when present**

Replace:

```vue
        <div class="card-title">
          {{ assignedName ? `Was assigned to ${assignedName}` : 'No contributor' }}
        </div>
```

with:

```vue
        <div class="card-title title-with-avatar">
          <UserAvatar v-if="assignedAid" :aid="assignedAid" :name="assignedName" :size="20" />
          <span>{{ assignedName ? `Was assigned to ${assignedName}` : 'No contributor' }}</span>
        </div>
```

- [ ] **Step 5: Add the layout helper style**

In `AssignmentCard.vue`'s `<style scoped>`, add:

```scss
.title-with-avatar {
  display: flex;
  align-items: center;
  gap: 8px;
}
```

- [ ] **Step 6: Type-check + smoke**

```
cd frontend && npx vue-tsc --noEmit 2>&1 | grep "AssignmentCard" || echo "clean"
```
Expected: `clean`. Smoke (dev app http://localhost:5100): open an assigned contribution — the assignee avatar shows before the name and clicking it opens the profile dialog.

- [ ] **Step 7: Commit**

```
git add frontend/src/components/contributions/AssignmentCard.vue
git commit -m "feat(contributions): show clickable avatar before name in AssignmentCard" -m "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Migration recipe (Tasks 6–9)

For each site: import `UserAvatar`, replace the existing avatar `<div>/<img>/initials` markup with a single `<UserAvatar>`, and delete the now-unused avatar CSS + any now-unused `*Avatar`/`*Initials`/`avatarColor` computeds/helpers in that file. Props:
- `:aid` — the user's AID (enables click-to-view). Use the AID the site already derives for that avatar.
- `:name` — the display name the site already shows (avatars render immediately even before the profiles store resolves).
- `:src` — only when the site has a direct avatar URL/ref not in the store (rare).
- `:size` — match the previous avatar's pixel size (check the removed CSS).
- `:clickable="false"` — bucket B only.

If a site's avatar has **no reliable AID** (e.g. a comment that only stored `user_name`), pass `:name` only and omit `:aid` — it renders non-clickable, matching the spec's edge-case rule. Prefer wiring `:aid` when the row's data carries one (most comment/author records resolve an AID via SharedProfile already).

---

## Task 6: Migrate contributions avatars (clickable)

**Files:**
- `frontend/src/components/contributions/ContributionDetailBody.vue` (block at lines ~9-17: `.assigned-avatar`)
- `frontend/src/components/projects/ContributionCardCompact.vue` (lines ~30-34: `.compact-avatar`)
- `frontend/src/components/contributions/ContributionSlimCard.vue` (lines ~6-10: `.slim-card-avatar`)

- [ ] **Step 1: ContributionDetailBody** — import `UserAvatar`; replace the `.assigned-avatar` block:

```vue
        <div v-if="assignedAid" class="assigned-avatar">
          <q-tooltip>Assigned to {{ assignedName }}</q-tooltip>
          <img v-if="assignedAvatar" :src="assignedAvatar" class="avatar-img" />
          <span v-else class="avatar-initials">{{ assignedInitials }}</span>
        </div>
```

with (UserAvatar has no `<slot/>`, so no tooltip child — its `aria-label` carries the name, and the name is shown beside it):

```vue
        <UserAvatar v-if="assignedAid" :aid="assignedAid" :name="assignedName" :size="32" class="assigned-avatar" />
```

Then grep the file for `assignedAvatar` and `assignedInitials`; remove those computeds **only if** nothing else references them (keep `assignedAid`/`assignedName`). Remove `.assigned-avatar`, `.avatar-img`, `.avatar-initials` CSS if unused elsewhere in the file.

- [ ] **Step 2: ContributionCardCompact** — replace the `.compact-avatar` block (lines ~30-34) with `<UserAvatar :aid="assignedAid" :name="assignedName" :size="<previous px>" />` (read `.compact-avatar` CSS for the size). Remove unused `compact-avatar*` CSS + `assignedAvatar`/`assignedInitials` if now unreferenced.

- [ ] **Step 3: ContributionSlimCard** — same treatment for the `.slim-card-avatar` block (lines ~6-10).

- [ ] **Step 4: Type-check**

```
cd frontend && npx vue-tsc --noEmit 2>&1 | grep -E "ContributionDetailBody|ContributionCardCompact|ContributionSlimCard" || echo "clean"
```
Expected: no new errors (pre-existing `AttachedFile` errors in ContributionDetailBody are unrelated).

- [ ] **Step 5: Commit**

```
git add frontend/src/components/contributions/ContributionDetailBody.vue frontend/src/components/projects/ContributionCardCompact.vue frontend/src/components/contributions/ContributionSlimCard.vue
git commit -m "refactor(contributions): use shared UserAvatar for assignee avatars" -m "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Migrate proposals avatars (clickable)

**Files:**
- `frontend/src/components/proposals/ProposalDetailModal.vue` (line ~169: `.comment-avatar`, name = `c.user_name`)
- `frontend/src/pages/ProposalDetailPage.vue` (line ~350: `.comment-avatar`, name = `commentDisplayName(c)`; AID resolvable via the SharedProfile match at lines ~709/939)
- `frontend/src/components/proposals/GovernanceActionModal.vue` (line ~250: `.vote-comment-avatar`)

- [ ] **Step 1:** In each file import `UserAvatar` and replace the comment/vote avatar markup with `<UserAvatar :aid="<comment author aid or ''>" :name="<existing display name>" :size="<previous px>" />`. For `ProposalDetailModal` comments that only have `c.user_name` and no AID, pass `:name="c.user_name"` and omit `:aid` (non-clickable). For `ProposalDetailPage`, pass the comment's author AID if the comment object carries one (`c.user_id`/`c.author_aid` — check the type); else `:name` only.

- [ ] **Step 2:** Remove now-unused avatar CSS (`.comment-avatar`, `.vote-comment-avatar`, related `*-img`/initials) and any avatar-only color/initials helpers left unreferenced.

- [ ] **Step 3: Type-check**

```
cd frontend && npx vue-tsc --noEmit 2>&1 | grep -E "ProposalDetailModal|ProposalDetailPage|GovernanceActionModal" || echo "clean"
```
Expected: no new errors.

- [ ] **Step 4: Commit**

```
git add frontend/src/components/proposals/ProposalDetailModal.vue frontend/src/pages/ProposalDetailPage.vue frontend/src/components/proposals/GovernanceActionModal.vue
git commit -m "refactor(proposals): use shared UserAvatar for comment/vote avatars" -m "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Migrate activity + chat avatars (clickable)

**Files:**
- `frontend/src/components/activity/FeedCard.vue` (lines ~31-34: `.author-avatar`; name `authorDisplayName`, url `authorAvatarUrl`, AID resolved near line ~132)
- `frontend/src/components/activity/CommentSection.vue` (lines ~10-12: `.comment-avatar`; name `getCommentAuthorName(comment)`, AID `comment.userId`, url `getCommentAvatarUrl(comment.userId)`)
- `frontend/src/components/chat/MessageItem.vue` (lines ~7-9: `.message-avatar`; has `displayName`, `avatarUrl`, `initials`; sender AID from the message prop — check for `senderAid`/`message.senderAid`)
- `frontend/src/components/chat/ThreadPanel.vue` (line ~27: `.reply-avatar`)

- [ ] **Step 1:** FeedCard — replace `.author-avatar` block with `<UserAvatar :aid="<author aid>" :name="authorDisplayName" :size="<previous px>" />`. Use the author AID the component already derives (the one matched near line ~132).

- [ ] **Step 2:** CommentSection — replace `.comment-avatar` block with `<UserAvatar :aid="comment.userId" :name="getCommentAuthorName(comment)" :size="<previous px>" />`.

- [ ] **Step 3:** MessageItem — replace the `.message-avatar` block (rendered for non-own messages) with `<UserAvatar :aid="<sender aid>" :name="displayName" :size="<previous px>" />`. Keep the `v-if="!isOwnMessage"` guard on the wrapper.

- [ ] **Step 4:** ThreadPanel — replace `.reply-avatar` similarly using the reply author's AID + name.

- [ ] **Step 5:** Remove unused avatar CSS + now-unreferenced `*AvatarUrl`/`getInitials`/`avatarColor` helpers in each file (grep before deleting).

- [ ] **Step 6: Type-check**

```
cd frontend && npx vue-tsc --noEmit 2>&1 | grep -E "FeedCard|CommentSection|MessageItem|ThreadPanel" || echo "clean"
```
Expected: no new errors.

- [ ] **Step 7: Commit**

```
git add frontend/src/components/activity/FeedCard.vue frontend/src/components/activity/CommentSection.vue frontend/src/components/chat/MessageItem.vue frontend/src/components/chat/ThreadPanel.vue
git commit -m "refactor(activity,chat): use shared UserAvatar for author avatars" -m "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: Migrate ProjectDetailPage avatars (clickable)

**Files:**
- `frontend/src/pages/Projects/ProjectDetailPage.vue` (comment avatars at line ~299; plus any lead/steward/assignee avatars — grep `avatar` in the file)

- [ ] **Step 1:** Import `UserAvatar`. Grep all avatar render points in the file:

```
grep -nE "avatar|q-avatar|initials" frontend/src/pages/Projects/ProjectDetailPage.vue | grep -v "\.comment-author"
```

- [ ] **Step 2:** Replace each user-avatar render with `<UserAvatar :aid="<aid>" :name="<name>" :size="<previous px>" />`, using the AID each spot already derives (comments resolve AID near line ~1036).

- [ ] **Step 3:** Remove unused avatar CSS/helpers.

- [ ] **Step 4: Type-check**

```
cd frontend && npx vue-tsc --noEmit 2>&1 | grep "ProjectDetailPage" || echo "clean"
```
Expected: no new errors (a pre-existing `Milestone.contributions` / comparison error may remain — unrelated).

- [ ] **Step 5: Commit**

```
git add frontend/src/pages/Projects/ProjectDetailPage.vue
git commit -m "refactor(projects): use shared UserAvatar in project detail" -m "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 10: Non-clickable migrations + final decisions

**Files:**
- `frontend/src/pages/DashboardPage.vue` (members list avatars)
- `frontend/src/components/projects/AssignRoleDialog.vue` (member picker)
- `frontend/src/pages/AccountSettingsPage.vue` (own-avatar upload control)
- `frontend/src/components/onboarding/ProfileConfirmationScreen.vue` (own-profile preview)
- Decide: `frontend/src/components/profiles/TypedDisplay.vue`, `frontend/src/components/profiles/ProfileCard.vue`

- [ ] **Step 1:** DashboardPage members list — replace each member-row avatar with `<UserAvatar :aid="<member aid>" :name="<member name>" :size="<previous px>" :clickable="false" />`. The row's existing `@click` still opens the rich steward ProfileModal; the avatar must NOT open the read-only viewer, hence `:clickable="false"`.

- [ ] **Step 2:** AssignRoleDialog member picker — same: `<UserAvatar ... :clickable="false" />` so the row click still selects.

- [ ] **Step 3:** AccountSettingsPage — the avatar is an upload control; render `<UserAvatar ... :clickable="false" />` (or leave the upload widget as-is if it's not a plain display avatar — read the file and decide; do not break upload).

- [ ] **Step 4:** ProfileConfirmationScreen — own-profile preview: `<UserAvatar ... :clickable="false" />`.

- [ ] **Step 5:** TypedDisplay / ProfileCard — `grep -n "avatar" frontend/src/components/profiles/TypedDisplay.vue frontend/src/components/profiles/ProfileCard.vue`. If either renders a standard user avatar that isn't already a click target, migrate to `<UserAvatar>` (clickable for TypedDisplay if it shows other users; `:clickable="false"` for ProfileCard since the card itself is the click target in the members list). If they don't render user avatars, leave them and note so in the commit message.

- [ ] **Step 6: Type-check**

```
cd frontend && npx vue-tsc --noEmit 2>&1 | grep -E "DashboardPage|AssignRoleDialog|AccountSettingsPage|ProfileConfirmationScreen|TypedDisplay|ProfileCard" || echo "clean"
```
Expected: no new errors.

- [ ] **Step 7: Commit**

```
git add -A
git commit -m "refactor(profiles): non-clickable UserAvatar on members/picker/own-profile" -m "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 11: Final verification

**Files:** none (verification only)

- [ ] **Step 1: Unit test**

```
cd frontend && npx vitest run tests/scripts/avatar.test.ts
```
Expected: PASS.

- [ ] **Step 2: Full type check**

```
cd frontend && npx vue-tsc --noEmit
```
Expected: no NEW errors vs. main (pre-existing `AttachedFile`, `Milestone.contributions`, etc. are acceptable).

- [ ] **Step 3: Manual smoke (dev app, http://localhost:5100)**

1. Open an assigned contribution → assignee avatar shows before the name; click it → read-only profile dialog opens; Close works.
2. Open a chat message from another user → click their avatar → dialog opens.
3. Open the activity feed → click an author avatar → dialog opens.
4. Members list (Dashboard) → click a member row → the **rich steward** modal opens (endorse/approve/remove), NOT the read-only one; clicking the avatar specifically does not open the read-only viewer.
5. Account settings → own avatar is not hijacked (upload still works / not clickable to dialog).
6. Click your OWN avatar somewhere in bucket A (e.g. a contribution you're assigned to) → read-only dialog opens.

- [ ] **Step 4: Bump version**

In `frontend/package.json`, bump `version` to the next patch.

```
git add frontend/package.json
git commit -m "chore: bump version for clickable user avatars"
```
