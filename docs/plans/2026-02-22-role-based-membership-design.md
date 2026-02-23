# Role-Based Membership Design

## Overview

Upgrade the membership system to use role-based permissions. Remove embedded permissions from the membership credential schema. Add UI to update member roles from the members list. Add Founding Member and steward roles.

## Schema Changes

### Membership Credential (`matou-membership-schema.json`)

**Remove fields:**
- `permissions` array (permissions derived from role at runtime, not stored in credential)
- `verificationStatus`

**Update `role` enum to 10 values:**
- Member
- Contributor
- Community Steward
- Operations Steward
- Founding Member
- Financial Steward
- Governance Steward
- Treasury Steward
- Technical Steward
- Cultural Steward

Schema SAID will change (new version).

### Backend Permission Mapping

`GetPermissionsForRole()` updated with new roles. Permissions remain a backend-only runtime lookup — never stored in credentials.

## Role Update Flow

1. Operations Steward or Founding Member clicks role in member's profile modal
2. "Change Role" modal opens with role selector and confirm button
3. Frontend calls `PUT /api/v1/members/{aid}/role` with `{ "role": "newRole" }`
4. Backend:
   - Updates `CommunityProfile` in any-sync (immediate visibility)
   - Revokes old membership credential
   - Issues new membership credential with updated role via IPEX
5. Frontend refreshes member data, shows success notification

## API

### `PUT /api/v1/members/{aid}/role`

- **Auth:** Operations Steward or Founding Member only
- **Request:** `{ "role": "Community Steward" }`
- **Response:** `{ "success": true, "credentialSaid": "..." }`
- **Steps:** validate role -> update CommunityProfile -> revoke old credential -> issue new credential

## UI Components

### ChangeRoleModal.vue (new)

- Triggered from profile modal by clicking role label
- Shows 10 roles, current role highlighted
- Confirm + cancel buttons
- Loading state during credential re-issuance
- Only visible to Operations Steward / Founding Member

### ProfileCard / Profile Modal (updates)

- Role label clickable for authorized users
- Subtle edit indicator on hover

## Authorization

Only **Operations Steward** and **Founding Member** roles can update other members' roles.
