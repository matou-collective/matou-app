# Membership Endorsement Feature Design

**Date:** 2026-02-19
**Branch:** `membership-endorsements`

## Goal

Allow approved community members to endorse pending applicants by issuing KERI endorsement credentials. Endorsements are collected and displayed; the admin still manually admits members after seeing endorsements.

## Key Decisions

- **Who endorses:** Any approved member can endorse. Stewards can endorse AND admit.
- **Admission:** Two-step — endorsements collected, admin clicks "Admit" to complete approval flow.
- **Schema:** Uses friend's endorsement schema (`$id: EPIm7hiwSUt5css49iLXFPaPDFOJx0MmfNoB3PkSMXkh`) with simplified fields: hard-code `endorsementType='membership_endorsement'`, `confidence='high'`, optional message only.
- **Registry:** Personal credential registry per member, created during admission flow.
- **Endorsement visibility:** Badge on ProfileCard + detailed list in ProfileModal.
- **Storage:** Endorsement records stored in SharedProfile `endorsements` array.
- **Credential delivery:** Full IPEX grant to applicant (auto-admitted on their side).

## Architecture

### Credential Flow

```
Member clicks "Endorse" on pending profile
  → Frontend resolves applicant OOBI
  → keriClient.issueCredential() with member's personal registry
    - Schema: EPIm7hiwSUt5css49iLXFPaPDFOJx0MmfNoB3PkSMXkh
    - Attributes: endorsementType, claim, confidence, category, dt
    - Edge: links to applicant's registration EXN SAID
  → IPEX grant sent to applicant
  → Frontend updates SharedProfile.endorsements array via backend API
```

### Data Model

**SharedProfile additions:**
```typescript
endorsements: Array<{
  endorserAid: string;       // AID of the endorsing member
  endorserName: string;      // Display name at time of endorsement
  credentialSaid: string;    // SAID of the issued endorsement credential
  endorsedAt: string;        // ISO date-time
  message?: string;          // Optional endorsement message
}>
```

**CommunityProfile additions:**
```typescript
personalRegistryId: string;  // KERI registry for issuing credentials
```

**Endorsement credential attributes (simplified):**
```json
{
  "d": "<SAID>",
  "i": "<applicant AID>",
  "dt": "<ISO datetime>",
  "endorsementType": "membership_endorsement",
  "category": "membership",
  "claim": "I endorse this person's membership application",
  "confidence": "high"
}
```

### Frontend Changes

#### New: `useEndorsements` composable
- `endorseApplicant(registration, message?)` — issue endorsement credential + update SharedProfile
- Requires endorser's personal registry ID (from CommunityProfile)
- Follows same pattern as `useAdminActions.approveRegistration()`

#### Modified: `ProfileCard.vue`
- Show endorsement count badge when `endorsements.length > 0`
- Small `thumb_up` icon + count text below date label

#### Modified: `ProfileModal.vue`
- **Endorsement list section** — shows each endorsement (endorser name, date, message)
- **Button changes:**
  - Pending + approved member viewing: "Endorse" button
  - Pending + already endorsed by viewer: "Endorsed" (disabled)
  - Pending + steward viewing: "Endorse" + "Admit" buttons
  - Steward can still "Decline"
  - Approved member: no action buttons

#### Modified: `DashboardPage.vue`
- Pass current user's AID and approval status to ProfileModal
- Wire up endorse event handler

#### Modified: `useAdminActions.ts` — admission flow
- After profile creation, add step: create personal registry for new member
- Store registry ID in CommunityProfile

#### Modified: `useCredentialPolling.ts` — endorsee side
- Distinguish endorsement grants from membership grants by schema SAID
- Auto-admit endorsement credentials
- Track endorsements in new `endorsements` ref

#### Modified: `PendingApprovalScreen.vue` — endorsee side
- New "Community Endorsements" section showing received endorsements
- Updated "What happens next?" steps:
  1. Book a Whakawhānaunga Session
  2. Community Endorsements
  3. Admin Admission
  4. Welcome to Matou

### Backend Changes

#### New: `backend/schemas/matou-endorsement-schema.json`
- Store endorsement schema file

#### Modified: `backend/internal/keri/client.go`
- Add endorsement schema SAID constant
- Add `"membership_endorsement"` credential type

#### No new API endpoints
- Endorsement data stored via existing `createOrUpdateProfile` API
- Credential issuance handled by frontend via signify-ts

## Schema Reference

Endorsement schema from friend's fork:
- `$id`: `EPIm7hiwSUt5css49iLXFPaPDFOJx0MmfNoB3PkSMXkh`
- `credentialType`: `MatouEndorsementCredential`
- Required attributes: `d`, `i`, `dt`, `endorsementType`, `claim`, `confidence`
- Edge section: links to endorsee's membership credential (or registration EXN SAID for pending applicants)

Membership schema (existing):
- SAID: `EOVL3N0K_tYc9U-HXg7r2jDPo4Gnq3ebCjDqbJzl6fsT`

## Testing Strategy

- **E2E test:** Extend registration tests — second member endorses pending applicant, verify endorsement appears, admin admits
- **Manual testing:** 2 dev sessions (admin + member) to test full endorsement → admission flow
