# Event Attendance Credential Design

## Overview

Add a KERI credential for proving attendance at community events (e.g., Whakawhanaungatanga sessions). This is the 4th membership requirement — all four requirements must be met before an admin can admit an applicant.

## Requirements

- Admin/steward who hosts a session manually issues an attendance credential from their personal registry
- New dedicated schema (`MatouEventAttendanceCredential`) with event-specific fields
- Edge linking to the host's membership credential (proves host authority)
- Applicant-side credential polling detects the credential and lights up the "Whakawhanaunga" requirement card
- Admission is gated on all 4 requirements being met

## Schema: `matou-event-attendance-schema.json`

**credentialType**: `MatouEventAttendanceCredential`

**Attributes (`a`)**:
| Field | Type | Description |
|-------|------|-------------|
| `d` | string | Attributes block SAID |
| `i` | string | Attendee AID (credential recipient) |
| `dt` | date-time | Issuance timestamp |
| `eventType` | enum | `"community_onboarding"` or `"project_onboarding"` |
| `eventName` | string | e.g. `"Whakawhanaungatanga Session"` |
| `sessionDate` | date-time | Actual date/time of the session |

**Required**: `d`, `i`, `dt`, `eventType`, `eventName`, `sessionDate`

**Edge (`e`)**:
| Field | Description |
|-------|-------------|
| `d` | Edge block SAID |
| `hostMembership.n` | SAID of the host's membership credential |
| `hostMembership.s` | Membership schema SAID |

Same edge pattern as `endorserMembership` in the endorsement schema.

## Issuance Composable: `useEventAttendance.ts`

Follows the same pattern as `useEndorsements.ts`:

1. `markAttended(applicantAid, applicantOOBI?, sessionDate?)` — main action:
   - Get or create host's personal registry
   - Resolve event attendance schema OOBI
   - Resolve applicant OOBI
   - Look up host's own membership credential (for edge)
   - Issue credential with attributes and `hostMembership` edge
   - Update applicant's SharedProfile with attendance record
   - Refresh profiles

2. `hasMarkedAttended(applicantAid)` — check if current user already issued this credential to the applicant

## Credential Polling (Applicant Side)

In `useCredentialPolling.ts`:
- Import `EVENT_ATTENDANCE_SCHEMA_SAID`
- Detect IPEX grants matching the event attendance schema SAID
- Auto-admit the credential (same flow as endorsements)
- Set `sessionAttendanceVerified = true` when detected
- The existing requirement card on `PendingApprovalScreen` already reads this ref

## ProfileModal UI (Admin Side)

- Add "Mark Attended" button alongside existing "Endorse" button
- Disabled with "Attended" label if `hasMarkedAttended()` returns true
- Loading state while issuing (same pattern as endorse button)
- Only visible to admins/stewards viewing pending applicants

## Admission Gate

- All 4 requirement cards must be met before the "Admit" button is enabled
- Check applicant's SharedProfile for attendance record or verify via credential polling state
- Existing requirement cards already show the visual state; this adds the enforcement

## Files Changed

| File | Change |
|------|--------|
| `backend/schemas/matou-event-attendance-schema.json` | New schema file |
| `frontend/src/composables/useEventAttendance.ts` | New issuance composable |
| `frontend/src/composables/useAdminActions.ts` | Export `EVENT_ATTENDANCE_SCHEMA_SAID` constant |
| `frontend/src/composables/useCredentialPolling.ts` | Detect event attendance credentials |
| `frontend/src/components/onboarding/ProfileModal.vue` | Add "Mark Attended" button |
| Schema server deployment | Register new schema |
