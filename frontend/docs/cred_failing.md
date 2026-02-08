# KERI Frontend Credential Creation Failure Analysis
## 401 Unauthorized on Second Credential Attempt

### Error Pattern
```
First credential: SUCCESS
Second credential: 401 Unauthorized
All subsequent: 401 Unauthorized
```

### Failed Endpoints
```
GET  /identifiers/Not%20Gabriel
POST /identifiers/Not%20Gabriel/exchanges
```

---

## Expert Panel Analysis

### 1. SSI Specialist: Session & State Management

#### Primary Diagnosis: **Stale Authentication State**

```
Credential 1: Fresh AID context → Auth token valid → SUCCESS
Credential 2: Reused AID context → Auth token expired/invalidated → 401
```

**KERI-Specific Issues:**

The URL encoding `Not%20Gabriel` vs `Not Gabriel` indicates **identifier normalization problem**.

```typescript
// WRONG - space in identifier
const aid = "Not Gabriel"
fetch(`/identifiers/${aid}`)  // becomes /identifiers/Not%20Gabriel

// KERI identifiers should be:
// 1. Base64 encoded public keys (EO78r6C...)
// 2. Or qualified with proper CESR encoding
// NOT human-readable strings with spaces
```

**Root Cause Hypothesis:**

```
Issue 1: Using display name instead of cryptographic AID
├── First request: Backend creates temporary session
├── Second request: Session expired or AID mismatch
└── Result: 401 because "Not Gabriel" != cryptographic identifier

Issue 2: Rotation state desync
├── First credential creation rotates keys
├── Second attempt uses old pre-rotation keys
└── Signature verification fails → 401

Issue 3: Exchange (EXN) signer not updated
├── EXN signed with initial keys
├── After first credential, keys rotated
└── Second EXN signature invalid → 401
```

**Critical KERI Principle Violation:**

```python
# Anti-pattern detected
sender = "Not Gabriel"  # Human name
recipient = "EO78r6C..." # Cryptographic AID

# MUST be:
sender = "EABc123..."   # Cryptographic AID
recipient = "EO78r6C..." # Cryptographic AID

# Display names are metadata, not identifiers
```

---

### 2. Senior Full Stack: Authentication Token Lifecycle

#### Token Expiration After First Operation

**Observation Pattern:**
```
Operation 1: Token generated/valid → 200 OK
Operation 2: Token consumed/expired → 401
```

**Common SPA Auth Failures:**

```typescript
// Anti-pattern: Single-use token
class KERIClient {
  private authToken: string;
  
  async sendEXN() {
    // Token consumed on first use
    await fetch(url, {
      headers: { Authorization: `Bearer ${this.authToken}` }
    });
    // Token now invalid but not refreshed
  }
}

// Should be:
class KERIClient {
  private async getValidToken(): Promise<string> {
    if (this.isTokenExpired()) {
      await this.refreshToken();
    }
    return this.authToken;
  }
  
  async sendEXN() {
    const token = await this.getValidToken();
    // Fresh token for each request
  }
}
```

**SignifyClient Session Management:**

```typescript
// From error: SignifyClient.fetch throws 401
// This suggests SignifyClient has stale session

// Check client initialization:
const client = new SignifyClient(url, bran, tier);

// After first operation, client may need:
await client.connect();  // Re-establish connection
// OR
await client.authenticate();  // Refresh auth
```

**URL Encoding Issue:**

```typescript
// Current code (WRONG):
const aid = "Not Gabriel"
POST /identifiers/Not%20Gabriel/exchanges

// Server likely expects:
POST /identifiers/Not+Gabriel/exchanges
// OR properly encoded AID:
POST /identifiers/EABc123.../exchanges

// Fix:
const encodedAid = encodeURIComponent(aid)
// OR better - use actual cryptographic identifier:
const aid = await client.identifiers().create({name: displayName})
// Then use: aid.prefix (the actual AID, not the name)
```

---

### 3. Network/Pipeline: Request State Analysis

#### HTTP Client State Pollution

**Request Trace:**
```
Request 1: POST /identifiers/Not%20Gabriel/exchanges
├── Headers: Authorization: Bearer <TOKEN_A>
├── Body: {sender: "Not Gabriel", ...}
└── Response: 200 OK (credential created)

Request 2: POST /identifiers/Not%20Gabriel/exchanges  
├── Headers: Authorization: Bearer <TOKEN_A>  ← STALE
├── Body: {sender: "Not Gabriel", ...}
└── Response: 401 (token invalid/identifier mismatch)
```

**Session Invalidation Scenarios:**

```
Scenario A: Key rotation after first credential
└── First credential creation rotates current key
└── Second request signature uses old key
└── Backend rejects as unauthorized

Scenario B: Server-side session cleanup
└── POST /exchanges creates credential
└── Backend invalidates session as security measure
└── Next request needs re-authentication

Scenario C: CORS preflight caching
└── First OPTIONS request cached with valid token
└── Second request uses cached preflight
└── Actual token expired between requests
```

**Identifier Resolution Failure:**

```http
GET /identifiers/Not%20Gabriel
401 Unauthorized

This suggests backend cannot resolve "Not Gabriel" to an AID.
Likely causes:
1. Name-to-AID mapping expired
2. AID not in backend's habery after first operation
3. Authentication required but client not sending credentials
```

---

## Consolidated Root Cause

### **Using Display Name Instead of Cryptographic AID**

```typescript
// CURRENT (BROKEN):
const sender = "Not Gabriel";  // Display name
await client.identifiers().get(sender);  // 401 - not a valid AID

// CORRECT:
const identifier = await client.identifiers().create({
  name: "Not Gabriel"  // Display name is metadata
});

const sender = identifier.prefix;  // e.g., "EABc123..." - actual AID
await client.identifiers().get(sender);  // Works
```

### Secondary Issue: **No Token Refresh Between Operations**

```typescript
// After first credential creation:
// - Token may be single-use
// - Session may require refresh
// - Key state may have rotated

// Need explicit re-authentication:
await client.connect();
```

---

## Code Fixes

### client.ts - Fix AID Usage

```typescript
export class KERIClient {
  private identifierCache = new Map<string, string>();
  
  private async resolveAID(nameOrAid: string): Promise<string> {
    if (nameOrAid.startsWith('E')) return nameOrAid;
    
    if (this.identifierCache.has(nameOrAid)) {
      return this.identifierCache.get(nameOrAid)!;
    }
    
    const identifiers = await this.client.identifiers().list();
    const match = identifiers.aids.find(aid => aid.name === nameOrAid);
    
    if (!match) {
      throw new Error(`No AID found for name: ${nameOrAid}`);
    }
    
    this.identifierCache.set(nameOrAid, match.prefix);
    return match.prefix;
  }
  
  async sendEXN(sender: string, recipient: string, route: string, payload?: any) {
    const senderAid = await this.resolveAID(sender);
    const recipientAid = await this.resolveAID(recipient);
    
    console.log('[KERIClient] Creating EXN message for route:', route);
    console.log('[KERIClient] Sending EXN to', recipientAid);
    console.log('[KERIClient] EXN details:', {
      sender: senderAid,
      recipient: recipientAid,
      route
    });
    
    try {
      await this.ensureConnected();
      
      const result = await this.client.exchanges().sendFromEvents(
        senderAid,
        route,
        { recipient: recipientAid, ...payload }
      );
      
      return result;
    } catch (error) {
      console.error('[KERIClient] Failed to send EXN:', error);
      
      await this.reconnect();
      
      return await this.client.exchanges().sendFromEvents(
        senderAid,
        route,
        { recipient: recipientAid, ...payload }
      );
    }
  }
  
  private async ensureConnected() {
    try {
      await this.client.state();
    } catch {
      await this.reconnect();
    }
  }
  
  private async reconnect() {
    console.log('[KERIClient] Reconnecting...');
    await this.client.connect();
  }
  
  async sendRegistrationToAdmins(sender: string, admins: string[]) {
    const senderAid = await this.resolveAID(sender);
    
    for (const admin of admins) {
      const adminAid = await this.resolveAID(admin);
      
      try {
        await this.ensureConnected();
        
        await this.sendEXN(senderAid, adminAid, '/matou/registration/apply');
        
        const identifier = await this.client.identifiers().get(senderAid);
        
        await this.client.ipex().apply({
          senderName: identifier.name,
          recipient: adminAid,
          schema: 'matou-registration',
          attributes: {}
        });
      } catch (error) {
        console.error(`[KERIClient] Failed for admin ${admin}:`, error);
        continue;
      }
    }
  }
}
```

### useRegistration.ts - Add Session Management

```typescript
async function submitRegistration(displayName: string, mnemonic: string) {
  try {
    const client = await KERIClient.getInstance();
    
    let identifier = await client.findIdentifier(displayName);
    
    if (!identifier) {
      identifier = await client.createIdentifier(displayName, mnemonic);
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    await client.connect();
    
    const admins = await client.getAdminIdentifiers();
    
    for (let i = 0; i < admins.length; i++) {
      console.log(`Sending to admin ${i + 1}/${admins.length}`);
      
      await client.sendRegistrationToAdmins(
        identifier.prefix,
        [admins[i].prefix]
      );
      
      if (i < admins.length - 1) {
        await client.connect();
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }
    
    return { success: true };
  } catch (error) {
    console.error('Registration failed:', error);
    return { success: false, error };
  }
}
```

### MnemonicVerificationScreen.vue - Retry Logic

```typescript
async function handleVerify() {
  loading.value = true;
  error.value = null;
  
  const maxRetries = 3;
  let attempt = 0;
  
  while (attempt < maxRetries) {
    try {
      const result = await submitRegistration(
        displayName.value,
        mnemonic.value
      );
      
      if (result.success) {
        router.push('/success');
        return;
      }
      
      throw new Error(result.error);
    } catch (err) {
      attempt++;
      console.error(`Attempt ${attempt} failed:`, err);
      
      if (attempt < maxRetries) {
        await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
        continue;
      }
      
      error.value = 'Registration failed after multiple attempts';
    }
  }
  
  loading.value = false;
}
```

---

## Architectural Recommendations

### 1. Separate Display Names from AIDs

```typescript
interface UserIdentity {
  displayName: string;
  aid: string;
  created: Date;
  lastRotation: Date;
}

class IdentityManager {
  private identities = new Map<string, UserIdentity>();
  
  async getOrCreateIdentity(displayName: string): Promise<UserIdentity> {
    let identity = this.identities.get(displayName);
    
    if (!identity) {
      const identifier = await client.identifiers().create({
        name: displayName
      });
      
      identity = {
        displayName,
        aid: identifier.prefix,
        created: new Date(),
        lastRotation: new Date()
      };
      
      this.identities.set(displayName, identity);
      await this.persist();
    }
    
    return identity;
  }
}
```

### 2. Connection Pool Pattern

```typescript
class KERIConnectionPool {
  private connections: SignifyClient[] = [];
  private inUse = new Set<SignifyClient>();
  
  async acquire(): Promise<SignifyClient> {
    let client = this.connections.find(c => !this.inUse.has(c));
    
    if (!client) {
      client = new SignifyClient(url, bran, tier);
      await client.connect();
      this.connections.push(client);
    }
    
    this.inUse.add(client);
    return client;
  }
  
  release(client: SignifyClient) {
    this.inUse.delete(client);
  }
}
```

### 3. Token Refresh Interceptor

```typescript
class AuthInterceptor {
  async intercept(request: Request): Promise<Response> {
    const token = await this.getValidToken();
    
    request.headers.set('Authorization', `Bearer ${token}`);
    
    const response = await fetch(request);
    
    if (response.status === 401) {
      await this.refreshToken();
      
      const retryToken = await this.getValidToken();
      request.headers.set('Authorization', `Bearer ${retryToken}`);
      
      return await fetch(request);
    }
    
    return response;
  }
}
```

---

## Immediate Action Items

### Priority 1: Fix Identifier Usage
```diff
- const sender = "Not Gabriel"
+ const identifier = await client.identifiers().get("Not Gabriel")
+ const sender = identifier.prefix
```

### Priority 2: Add Connection Refresh
```diff
  async sendRegistrationToAdmins() {
+   await this.client.connect()
    await this.sendEXN(...)
+   await this.client.connect()
    await this.client.ipex().apply(...)
  }
```

### Priority 3: URL Encoding
```diff
- POST /identifiers/Not%20Gabriel/exchanges
+ POST /identifiers/${encodeURIComponent(aid)}/exchanges
```

### Priority 4: Error Recovery
```typescript
async sendWithRetry(fn: () => Promise<any>, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (error) {
      if (error.status === 401 && i < retries - 1) {
        await this.client.connect();
        continue;
      }
      throw error;
    }
  }
}
```

---

## Testing Checklist

```bash
# 1. Verify AID resolution
console.log(await client.identifiers().list())

# 2. Check token validity
await client.state()  # Should not throw

# 3. Test identifier lookup
const id = await client.identifiers().get("Not Gabriel")
console.log(id.prefix)  # Should print EABc123...

# 4. Verify URL construction
const url = `/identifiers/${encodeURIComponent(id.prefix)}/exchanges`
console.log(url)  # Should NOT contain spaces

# 5. Test connection refresh
await client.connect()
const state = await client.state()
console.log(state.controller)  # Should match AID
```

---

## Expected Behavior After Fix

```
First credential:
├── Resolve "Not Gabriel" → EABc123...
├── Connect to SignifyClient
├── Send EXN with AID EABc123...
└── Success: 200 OK

Second credential:
├── Resolve "Not Gabriel" → EABc123... (cached)
├── Refresh connection
├── Send EXN with AID EABc123...
└── Success: 200 OK

Third+ credentials:
└── Repeat with fresh connection each time
```

---

## Root Cause Summary

**Primary**: Using display name `"Not Gabriel"` instead of cryptographic AID prefix `"EABc123..."` in API calls

**Secondary**: No connection refresh between operations, causing token/session expiration

**Tertiary**: URL encoding inconsistency with identifier names containing spaces

**Fix Complexity**: Low (2-4 hours)
**Testing Required**: Medium (verify with multiple sequential credential creations)
