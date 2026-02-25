# Admin Member Removal

## Problem

Admins have no way to remove members from the community. There is no backend endpoint, no credential revocation triggered by removal, and no UI for it.

## Design

### Removal Flow

1. **Revoke credential** — Call `keriClient.revokeCredential()` with the member's membership credential SAID. Same mechanism as `upgradeMemberToSteward`.
2. **Soft-delete profiles** — Update CommunityProfile and SharedProfile with `status: 'removed'`, `removedAt`, `removedBy` (admin AID), and optionally `removalReason`.
3. **Filter UI** — Dashboard member list and community members endpoint filter out `status: 'removed'` profiles.

### Backend

- New endpoint: `DELETE /api/v1/members/{aid}`
- Request body: `{ "reason": "optional reason" }`
- Handler finds CommunityProfile by member AID, revokes credential via KERI, updates both profiles to `status: 'removed'`
- Authorization: `canManageMembers` permissions only (Operations Steward, Founding Member)

### Frontend

- "Remove Member" button in ProfileModal (admins only, approved members only, not self)
- Confirmation dialog with optional reason textarea
- Progress feedback during revocation
- Refreshes member list on completion

### Decisions

- Soft delete (profiles marked removed, not erased) for audit trail
- Reason is optional
- No notification to the removed member
- No any-sync ACL eviction (SDK doesn't support it; revoked credential prevents access)
- No undo/restore
