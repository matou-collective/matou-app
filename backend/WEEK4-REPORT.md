# Week 4 Implementation Report

**Task**: Frontend Foundation - Identity Creation UI & Recovery Flow
**Date**: January 23-24, 2026
**Status**: ✅ COMPLETE (Credential UI deferred)

---

## Week 4 Goal

**Objective**: Build the complete frontend onboarding experience with identity creation, mnemonic verification (forced), and identity recovery using 12-word recovery phrases.

### Why This Work Is Needed

The MATOU identity system puts users in full control of their cryptographic keys. This requires:

1. **Self-Sovereign Identity**: Users generate their own keys via mnemonic phrases
2. **Forced Verification**: Users MUST prove they saved their recovery phrase before proceeding
3. **True Recovery**: Users can recover their identity on any device using only their mnemonic
4. **No Backend Key Storage**: Keys are derived client-side; the backend never sees private keys

This week implements the critical UX decisions from UX.MD:
- Forced recovery phrase verification (3 random words)
- Maximum 3 verification attempts before showing phrase again
- Mnemonic-derived passcodes for deterministic identity recovery

---

## Week 4 Timeline

| Day | Focus | Status |
|-----|-------|--------|
| Day 1-2 | Identity Creation UI with Profile Form | ✅ Complete |
| Day 2-3 | Mnemonic Display & Forced Verification | ✅ Complete |
| Day 3-4 | Credential Display UI | ⏭️ Deferred |
| Day 4-5 | Identity Recovery Flow | ✅ Complete |

---

## Day 1-2: Identity Creation UI

**Status**: ✅ COMPLETE

### ProfileFormScreen.vue (460 lines)

Complete profile creation form with real KERI identity generation.

**Features Implemented**:

| Feature | Description |
|---------|-------------|
| Avatar Upload | Optional profile image with 5MB limit, preview, and removal |
| Display Name | Required field, 2+ characters, validation |
| Bio/Motivation | "Why would you like to join us?" - 500 char limit |
| Participation Interests | 7 selectable interest categories with descriptions |
| Custom Interests | Free-form text for additional interests (300 char limit) |
| Terms Agreement | Required checkbox with links to guidelines and privacy |
| Form Validation | Real-time validation with error messages |

**Identity Creation Flow**:

```
User fills form → Submit
    ↓
Generate 12-word BIP39 mnemonic
    ↓
Derive KERIA passcode from mnemonic (deterministic)
    ↓
Connect to KERIA (boot agent if new)
    ↓
Create AID in KERIA
    ↓
Store mnemonic in onboarding store
    ↓
Navigate to Profile Confirmation
```

**Loading States**:

The form shows a loading overlay with progressive messages:
1. "Generating recovery phrase..." - Creating your secure 12-word backup
2. "Connecting to identity network..." - Deriving keys from recovery phrase
3. "Creating your identity..." - Generating cryptographic keys
4. "Finalizing..." - Almost there!

**Participation Interest Options**:

| Value | Label | Description |
|-------|-------|-------------|
| `research_knowledge` | Research and Knowledge | Support inquiry, documentation, and knowledge sharing |
| `coordination_operations` | Coordination and Operations | Organize efforts, track tasks, and improve processes |
| `art_design` | Art and Designs | Create graphics, UI/UX, and brand assets |
| `discussion_community_input` | Discussions and Community Input | Participate in conversations and share feedback |
| `follow_learn` | Follow and Learn | Stay informed and learn at your own pace |
| `coding_technical_dev` | Coding and Technical Dev | Build and maintain software and infrastructure |
| `cultural_oversight` | Cultural Oversight | Ensure cultural alignment and respectful practices |

---

## Day 2-3: Mnemonic Display & Forced Verification

**Status**: ✅ COMPLETE

### ProfileConfirmationScreen.vue (234 lines)

Displays the created identity and recovery phrase with critical security warnings.

**Features Implemented**:

| Feature | Description |
|---------|-------------|
| ID Card | Visual card showing avatar, name, role, and AID |
| Mnemonic Grid | 12-word grid with word numbers (1-12) |
| Copy Button | Copy entire mnemonic to clipboard with feedback |
| Critical Warning | Amber warning box with security instructions |
| Confirmation Checkbox | Required before proceeding to verification |

**ID Card Display**:

```
┌─────────────────────────────────────────────┐
│ [Matou Logo]  MATOU IDENTITY    🔒 DECENTRALIZED │
│                                             │
│ [Avatar]  Name                              │
│           Member                            │
│                                             │
│ ┌─────────────────────────────────────────┐ │
│ │ 🔑 AUTONOMIC IDENTIFIER                 │ │
│ │ EAbcd1234...                            │ │
│ └─────────────────────────────────────────┘ │
└─────────────────────────────────────────────┘
```

**Security Warning Content**:

- This is the **only way** to recover your identity
- Write it down on paper and store it safely
- **Never** share it with anyone
- We cannot recover this for you

### MnemonicVerificationScreen.vue (274 lines)

Forced verification requiring users to enter 3 random words from their recovery phrase.

**Features Implemented**:

| Feature | Description |
|---------|-------------|
| Random Word Selection | 3 random indices chosen from 12 words |
| Word Input Fields | Labeled inputs showing which word number to enter |
| Real-time Validation | Green checkmarks for correct, red X for incorrect |
| Attempt Counter | Shows "Attempt X of 3" |
| Too Many Attempts | After 3 failures, shows option to view phrase again |
| Error Messages | Clear feedback on what went wrong |

**Verification Flow**:

```
Generate 3 random indices (e.g., 3, 7, 11)
    ↓
User enters word #3, #7, #11
    ↓
Validate each word (case-insensitive)
    ↓
If all correct → Continue to next screen
If any incorrect → Increment attempts, show errors
    ↓
After 3 failed attempts → Show "View phrase again" option
```

**Why This Matters**:

Without forced verification, users often skip saving their recovery phrase, leading to permanent loss of identity. This UX pattern is proven in cryptocurrency wallets to dramatically reduce recovery phrase loss incidents.

---

## Day 3-4: Credential Display UI

**Status**: ⏭️ DEFERRED

Credential display UI has been deferred to a later sprint. The existing `CredentialIssuanceScreen.vue` placeholder remains functional but will be enhanced in a future week.

**Rationale**: The core identity creation and recovery flows are more critical for the MVP. Credential display can be implemented after the invitation and registration flows (Week 5-6) are complete.

---

## Day 4-5: Identity Recovery Flow

**Status**: ✅ COMPLETE

### RecoveryScreen.vue (321 lines)

Complete identity recovery using the 12-word mnemonic phrase.

**Features Implemented**:

| Feature | Description |
|---------|-------------|
| 12-Word Input Grid | 3x4 grid of input fields for mnemonic words |
| Smart Paste | Paste entire phrase into first field, auto-fills all 12 |
| BIP39 Validation | Validates mnemonic against wordlist before attempting recovery |
| Loading States | Progressive messages during recovery |
| Success Display | Shows recovered AID and name |
| Error Handling | Clear error messages for invalid phrases |

**Recovery Flow**:

```
User enters 12-word mnemonic
    ↓
Validate BIP39 format
    ↓
Derive KERIA passcode from mnemonic
    ↓
Connect to KERIA with derived passcode
    ↓
Agent exists? → Success! Show recovered identity
Agent doesn't exist? → Error: "No identity found for this phrase"
    ↓
Continue to Dashboard
```

**Key Technical Achievement**: True deterministic recovery is possible because:
1. Mnemonic → Seed (via `mnemonicToSeedSync`)
2. Seed → Raw bytes (first 16 bytes)
3. Raw bytes → Salter → qb64 passcode
4. Passcode deterministically derives KERIA agent keys

### KERIClient Enhancements (client.ts)

Added recovery-related methods:

```typescript
/**
 * Derive a passcode (bran) from a BIP39 mnemonic phrase
 * This allows users to recover their identity using their 12-word phrase
 * @param mnemonic - 12-word BIP39 mnemonic phrase (space-separated)
 * @returns 21-character base64 passcode derived from the mnemonic
 */
static passcodeFromMnemonic(mnemonic: string): string {
  // Validate mnemonic
  if (!validateMnemonic(mnemonic, wordlist)) {
    throw new Error('Invalid mnemonic phrase');
  }

  // Convert mnemonic to 64-byte seed
  const seed = mnemonicToSeedSync(mnemonic);

  // Take first 16 bytes (same size as randomPasscode uses)
  const raw = seed.slice(0, 16);

  // Create Salter and extract qb64 passcode (same as randomPasscode)
  const salter = new Salter({ raw: raw });
  return salter.qb64.substring(2, 23);
}

/**
 * Validate a BIP39 mnemonic phrase
 */
static validateMnemonic(mnemonic: string): boolean {
  return validateMnemonic(mnemonic, wordlist);
}
```

**Dependencies Added**:
- `@scure/bip39`: BIP39 mnemonic generation and validation
- `@scure/bip39/wordlists/english`: English wordlist

---

## Infrastructure Enhancement

### KERIA CORS Support

**File**: `infrastructure/keri/docker-compose.yml`

Enabled native CORS in KERIA via environment variable:

```yaml
keria:
  environment:
    - KERI_AGENT_CORS=1  # Enable CORS headers
```

This eliminates the need for reverse proxies or browser flags during development, allowing the frontend to communicate directly with KERIA.

---

## Onboarding Store Updates

### stores/onboarding.ts (237 lines)

Enhanced state management for the complete onboarding flow.

**New State**:

```typescript
interface MnemonicState {
  words: string[];           // 12-word mnemonic
  verificationIndices: number[];  // Which 3 words to verify
  attempts: number;          // Failed verification attempts
  verified: boolean;         // Has passed verification
}
```

**New Actions**:

| Action | Description |
|--------|-------------|
| `setMnemonic(words)` | Store mnemonic and generate random verification indices |
| `recordVerificationAttempt(success)` | Track verification attempts |
| `resetMnemonicVerification()` | Reset for retry (new random indices) |

**Navigation Flow Implemented**:

```
Splash
  ├─→ [Register] → Matou Info → Profile Form → Profile Confirmation
  │                                               → Mnemonic Verification
  │                                                   → Pending Approval
  │
  ├─→ [Invite Code] → Invitation Welcome → Profile Form → Profile Confirmation
  │                                                         → Mnemonic Verification
  │                                                             → Credential Issuance
  │
  └─→ [Recover] → Recovery Screen → Dashboard
```

---

## E2E Test Suite Updates

### tests/e2e/registration.spec.ts (426 lines)

Extended test suite with comprehensive coverage.

**New Tests**:

| Test | Description |
|------|-------------|
| `complete registration flow with identity creation` | Full flow: splash → profile → mnemonic → verification → pending |
| `recover identity using mnemonic` | Create identity, clear session, recover using saved mnemonic |
| `debug CORS issue with KERIA` | Diagnostic test for CORS configuration |

**Registration Flow Test Steps**:

1. Load splash screen
2. Navigate to registration via Register button
3. Fill profile form (name, bio, terms)
4. Submit and create identity (waits for KERIA)
5. Verify profile confirmation screen
6. Extract mnemonic words for verification
7. Complete mnemonic verification with correct words
8. Arrive at pending approval screen

**Recovery Flow Test Steps**:

1. Create identity (full registration flow)
2. Save mnemonic words and AID
3. Clear localStorage session
4. Navigate to recovery screen
5. Enter saved mnemonic words
6. Verify recovered AID matches original
7. Continue to dashboard

**Test Results**:

```
Running 4 tests using 1 worker

✓  KERIA is accessible from test runner (284ms)
✓  complete registration flow with identity creation (45.2s)
✓  recover identity using mnemonic (78.6s)
✓  debug CORS issue with KERIA (1.2s)

4 passed (125.3s)
```

---

## Files Created/Modified

### Created

| File | Lines | Purpose |
|------|-------|---------|
| `frontend/src/components/onboarding/ProfileFormScreen.vue` | 460 | Complete profile form with identity creation |
| `frontend/src/components/onboarding/ProfileConfirmationScreen.vue` | 234 | ID card and mnemonic display |
| `frontend/src/components/onboarding/MnemonicVerificationScreen.vue` | 274 | Forced 3-word verification |
| `frontend/src/components/onboarding/RecoveryScreen.vue` | 321 | Full identity recovery flow |

### Modified

| File | Changes | Purpose |
|------|---------|---------|
| `frontend/src/lib/keri/client.ts` | +40 lines | Added `passcodeFromMnemonic()` and `validateMnemonic()` |
| `frontend/src/stores/onboarding.ts` | +129 lines | Mnemonic state, verification tracking, navigation |
| `frontend/src/pages/OnboardingPage.vue` | +79 lines | Recovery flow routing, mnemonic props |
| `frontend/tests/e2e/registration.spec.ts` | +306 lines | Full registration and recovery tests |
| `frontend/package.json` | +3 lines | Added `@scure/bip39` dependency |
| `infrastructure/keri/docker-compose.yml` | +1 line | KERI_AGENT_CORS environment variable |

---

## Architecture Reference

```
┌─────────────────────────────────────────────────────────────────┐
│                    WEEK 4 FOCUS AREA                             │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  User Device (Frontend)                                          │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │                                                             │ │
│  │  ProfileFormScreen                                          │ │
│  │       │                                                     │ │
│  │       ▼ generateMnemonic()                                  │ │
│  │  ┌─────────────────────┐                                    │ │
│  │  │ 12-word BIP39       │                                    │ │
│  │  │ Mnemonic            │────► Stored in Pinia store         │ │
│  │  └─────────┬───────────┘      (never sent to server)        │ │
│  │            │                                                 │ │
│  │            ▼ passcodeFromMnemonic()                         │ │
│  │  ┌─────────────────────┐                                    │ │
│  │  │ Derived Passcode    │────► Connects to KERIA             │ │
│  │  │ (deterministic)     │      (creates/boots agent)         │ │
│  │  └─────────────────────┘                                    │ │
│  │                                                             │ │
│  │  ProfileConfirmationScreen                                  │ │
│  │       │                                                     │ │
│  │       ▼ Display mnemonic grid                               │ │
│  │                                                             │ │
│  │  MnemonicVerificationScreen                                 │ │
│  │       │                                                     │ │
│  │       ▼ Verify 3 random words (FORCED)                      │ │
│  │                                                             │ │
│  │  RecoveryScreen                                             │ │
│  │       │                                                     │ │
│  │       ▼ Enter 12 words → Derive passcode → Reconnect        │ │
│  │                                                             │ │
│  └────────────────────────────────────────────────────────────┘ │
│                          │                                       │
│                          ▼                                       │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │                    KERIA (Port 3901/3903)                   │ │
│  │                                                             │ │
│  │  • Agent keyed by passcode (deterministic)                  │ │
│  │  • Creates AIDs on request                                  │ │
│  │  • Same passcode = same agent = same AIDs                   │ │
│  │                                                             │ │
│  └────────────────────────────────────────────────────────────┘ │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## Week 4 Success Criteria

### Identity Creation UI ✅

- [x] Profile form with all required fields
- [x] Avatar upload with preview and validation
- [x] Participation interests selection
- [x] Terms agreement checkbox (required)
- [x] Form validation with error messages
- [x] Loading overlay with progress messages
- [x] Real KERI AID creation via signify-ts

### Mnemonic Display ✅

- [x] 12-word grid with word numbers
- [x] Copy to clipboard functionality
- [x] Critical security warnings
- [x] Confirmation checkbox before proceeding
- [x] ID card showing profile and AID

### Forced Verification ✅

- [x] 3 random words selected for verification
- [x] Input validation (case-insensitive)
- [x] Visual feedback (checkmarks/X icons)
- [x] Attempt counter (max 3)
- [x] "Show phrase again" option after failures
- [x] Cannot skip verification

### Identity Recovery ✅

- [x] 12-word input grid
- [x] Smart paste (auto-fills all fields)
- [x] BIP39 validation
- [x] Passcode derivation from mnemonic
- [x] KERIA reconnection with derived passcode
- [x] Success/error states
- [x] Continue to dashboard

### E2E Tests ✅

- [x] Full registration flow test
- [x] Recovery flow test
- [x] Mnemonic verification test
- [x] All tests passing

### Deferred ⏭️

- [ ] Credential display UI (moved to Week 5-6)

---

## Known Issues & Technical Debt

1. **Passcode Storage**: Currently stored in plain localStorage. Should be encrypted for production.

2. **CORS in Production**: Development uses `KERI_AGENT_CORS=1`. Production needs proper reverse proxy setup.

3. **Witness-backed AIDs**: Currently creating AIDs without witnesses for faster development. Production should use 2-of-3 witness threshold.

4. **Error Recovery**: If identity creation fails mid-way, user must restart. Could add resume capability.

---

## Next Steps (Week 5)

Week 5 focuses on **Invitation Implementation**:

1. **Backend**: Invitation endpoints (issue, accept, cancel)
2. **Frontend**: Invitation UI (send, receive, manage)
3. **Integration**: Bidirectional credential flow

The foundation built this week (identity creation, mnemonic management, KERIA integration) provides the base for the credential-based invitation system.

---

## Auto-Restore Identity on App Startup

**Status**: ✅ COMPLETE

### Overview

Implemented automatic identity restoration when the app starts. Returning users are automatically recognized and navigated to the appropriate screen without needing to re-enter credentials.

### What Information is Saved Locally

The only piece of information saved locally is the **KERIA passcode** stored in `localStorage`:

```javascript
localStorage.setItem('matou_passcode', passcode);
// Key: 'matou_passcode'
// Value: 21-character base64 string (e.g., "0ABQ1234abcd5678efgh9")
```

**Important Security Notes**:
- The passcode is derived deterministically from the user's 12-word mnemonic
- The mnemonic itself is NEVER stored locally
- The passcode alone cannot recover the mnemonic (one-way derivation)
- For production, this should be encrypted (noted in Known Issues)

### How the Passcode is Derived

The passcode is derived from the mnemonic using a deterministic process:

```
12-word Mnemonic
    ↓ mnemonicToSeedSync()
64-byte BIP39 Seed
    ↓ slice(0, 16)
16-byte Raw Bytes
    ↓ new Salter({ raw })
KERI Salter Object
    ↓ salter.qb64.substring(2, 23)
21-character Base64 Passcode
```

This means:
- **Same mnemonic → Same passcode → Same KERIA agent → Same AIDs**
- Recovery works because the passcode derivation is deterministic
- Two users with different mnemonics cannot have the same passcode

### How Auto-Restore Works
    
  1. On App Start: Boot file checks localStorage.getItem('matou_passcode')
  2. If Passcode Exists:                             
    - Show loading state ("Checking your identity...")
    - Connect to KERIA using the passcode
    - KERIA recognizes the passcode → returns existing agent with AIDs
    - Navigate user to pending-approval screen                        
  3. If No Passcode: Show splash with normal buttons (fresh user)                                  
  4. If Connection Fails: Show error with retry button, clear bad passcode
  
  **Why This Works**
  
  The passcode is the "key" to the user's KERIA agent:

  Passcode → KERIA Agent → AIDs (identities)

  Since the passcode is derived from the mnemonic, and the same passcode always connects to the same agent, returning users are automatically recognized without storing any actual identity  
  data locally.

  Security: The mnemonic is NEVER stored. Even if someone steals the passcode from localStorage, they cannot recover the mnemonic (one-way derivation), and they would need access to the     
  KERIA server to use it.   

**Startup Flow**:

```
App Start
    ↓
Boot file checks localStorage('matou_passcode')
    │
    ├─ No passcode found
    │       ↓
    │   Set appState='ready'
    │       ↓
    │   Show Splash (buttons visible)
    │
    └─ Passcode found
            ↓
        Set appState='checking'
            ↓
        Show Splash (loading state: "Checking your identity...")
            ↓
        Call identityStore.restore()
            │
            ├─ Success + hasAID
            │       ↓
            │   Navigate to 'pending-approval'
            │   (User sees their pending application)
            │
            ├─ Success + no AID
            │       ↓
            │   Show Splash (buttons visible)
            │   (Connected but no identity yet)
            │
            └─ Failed (KERIA unavailable, invalid passcode)
                    ↓
                Set initializationError
                Clear invalid passcode from localStorage
                    ↓
                Show Splash (error state + retry button)
```

### Files Modified for Auto-Restore

| File | Changes |
|------|---------|
| `frontend/src/stores/identity.ts` | Added `isInitializing`, `initError`, `isReady`, `setInitialized()`, `setInitError()`. Modified `restore()` to return `{ success, hasAID, error }` |
| `frontend/src/stores/onboarding.ts` | Added `appState`, `initializationError`, `isLoading`, `setAppState()`, `setInitializationError()` |
| `frontend/src/boot/keri.ts` | Non-blocking restore that allows Vue to mount and show loading state |
| `frontend/src/components/onboarding/SplashScreen.vue` | Added loading dots animation, error banner, retry button, conditional rendering |
| `frontend/src/pages/OnboardingPage.vue` | Added `handleRetry()` function for error recovery |

### UI States

**Loading State**:
```
┌─────────────────────────────────┐
│           [Logo]                │
│           Matou                 │
│  Community · Connection · Gov   │
│                                 │
│         ● ● ●                   │  ← Animated dots
│  Checking your identity...      │
│                                 │
└─────────────────────────────────┘
```

**Error State**:
```
┌─────────────────────────────────┐
│           [Logo]                │
│           Matou                 │
│  Community · Connection · Gov   │
│                                 │
│  ⚠️ Connection Error            │
│  Failed to fetch               │
│                                 │
│     [ 🔄 Try Again ]            │
│                                 │
└─────────────────────────────────┘
```

### E2E Test Coverage

Created `tests/e2e/auto-restore.spec.ts` with 5 tests:

| Test | Description | Result |
|------|-------------|--------|
| Fresh user without passcode | No passcode → sees splash with buttons immediately | ✅ Pass |
| Returning user with valid identity | Valid passcode + AID → auto-navigates to pending-approval | ✅ Pass |
| KERIA unavailable | Shows error state with retry button, clears passcode on error | ✅ Pass |
| Invalid passcode | Handles gracefully, shows splash buttons | ✅ Pass |
| Loading state during slow check | Loading UI visible during delayed KERIA response | ✅ Pass |

### Security Considerations

1. **Passcode Storage**: Currently plain localStorage. Production should use:
   - Web Crypto API for encryption
   - Secure storage APIs where available
   - Consider session-only storage option

2. **Passcode Clearing**: Invalid or failed passcodes are automatically cleared to prevent repeated failures

3. **No Sensitive Data Exposed**: The passcode cannot be reverse-engineered to the mnemonic. Even if stolen, an attacker would need the KERIA server to be compromised to use it.

4. **Local-Only**: The passcode is never transmitted to any backend other than KERIA (which the user controls)

---

## References

- [MVP Implementation Plan V2](../Keri-AnySync-Research/MVP-IMPLEMENTATION-PLAN-V2.md)
- [UX Design Decisions](../Keri-AnySync-Research/UX.MD)
- [signify-ts Integration Guide](../frontend/docs/SIGNIFY-TS-INTEGRATION.md)
- [MATOU Architecture](../Keri-AnySync-Research/MATOU-ARCHITECTURE.md)
