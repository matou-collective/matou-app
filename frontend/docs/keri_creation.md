# KERI AID Creation 401 Error Analysis
## Same Root Cause: Display Name vs Cryptographic AID

### Error Context
```
Operation: AID creation completed successfully
├── AID: EPprcIy-6_tK6rvq558X09bl04MDFd9GYtHoyt5e4-Xi
├── Name: "Please Work"
└── Status: done=false, error=null

Subsequent GET: /identifiers/Please%20Work → 401 Unauthorized
```

---

## Critical Observation

**The AID was created successfully**, but immediately afterward the code tries to GET it by name instead of prefix:

```typescript
// ✓ Creation succeeded
{
  name: "Please Work",
  pre: "EPprcIy-6_tK6rvq558X09bl04MDFd9GYtHoyt5e4-Xi",  // The real AID
  sn: 0
}

// ❌ Then tries to fetch by display name
GET /identifiers/Please%20Work  // Should be EPprcIy-6_tK...
```

---

## Expert Panel Quick Analysis

### Pattern Confirmation: **Display Name Misuse Throughout Codebase**

This is the **same architectural flaw** as the credential creation issue, but occurring earlier in the lifecycle.

```
Flow:
1. Create AID with name "Please Work" ✓
2. Wait for operation completion ✓
3. Try to GET /identifiers/Please%20Work ✗ (should use prefix)
4. 401 because backend doesn't recognize "Please Work" as valid AID
5. Fallback to list() succeeds ✓ (returns all AIDs)
6. Extract the AID from list results ✓
7. Try to add agent role using name again ✗
8. Another 401
```

---

## Code Fix for client.ts

### Current (Broken) Pattern

```typescript
async createAID(name: string, options?: any) {
  const result = await this.client.identifiers().create({
    name: name,  // "Please Work"
    ...options
  });
  
  // ❌ WRONG: Tries to get by name
  const aid = await this.client.identifiers().get(name);
  
  return aid;
}
```

### Fixed Pattern

```typescript
async createAID(name: string, options?: any) {
  console.log(`[KERIClient] Creating AID with name: ${name}`);
  
  const op = await this.client.identifiers().create({
    name: name,
    ...options
  });
  
  console.log('[KERIClient] Operation:', op);
  
  await this.waitForOperation(op);
  
  console.log('[KERIClient] AID operation completed');
  
  // ✓ CORRECT: Get the prefix from the operation result
  const prefix = op.response?.i || op.metadata?.pre;
  
  if (!prefix) {
    throw new Error('No AID prefix in operation response');
  }
  
  console.log(`[KERIClient] Created AID: ${prefix} for name: ${name}`);
  
  // ✓ Use prefix for subsequent operations
  try {
    const aid = await this.client.identifiers().get(prefix);
    console.log(`[KERIClient] Verified AID: ${aid.prefix}`);
    return aid;
  } catch (error) {
    console.log('[KERIClient] Direct get failed, using list()');
    
    const aids = await this.client.identifiers().list();
    const match = aids.aids.find(a => a.prefix === prefix || a.name === name);
    
    if (!match) {
      throw new Error(`Failed to find created AID for ${name}`);
    }
    
    console.log(`[KERIClient] Found AID via list: ${match.prefix}`);
    return match;
  }
}

async addAgentRole(aid: string) {
  // ✓ CRITICAL: Parameter should already be the prefix, not name
  console.log('[KERIClient] Adding agent end role for AID:', aid);
  
  if (!aid.startsWith('E')) {
    throw new Error(`Invalid AID prefix: ${aid}. Must use cryptographic identifier, not display name.`);
  }
  
  const agentEID = await this.getAgentEID();
  console.log('[KERIClient] Agent EID:', agentEID);
  
  // ✓ Use prefix in endpoint URL
  const op = await this.client.identifiers().addEndRole(
    aid,  // Must be prefix like "EPprcIy..."
    'agent',
    agentEID
  );
  
  await this.waitForOperation(op);
  console.log('[KERIClient] Agent role added');
}
```

---

## Root Cause: Operation Response Not Used

The operation object contains the AID prefix but code ignores it:

```typescript
// Operation response structure
{
  name: "Please Work",          // Display name
  metadata: {
    pre: "EPprcIy-6_tK...",     // ← THIS is the AID to use
    sn: 0
  },
  done: false,
  error: null,
  response: {
    i: "EPprcIy-6_tK...",       // ← OR this
    s: "0",
    // ... full inception event
  }
}

// Current code ignores these and tries:
GET /identifiers/Please%20Work  // ❌ Wrong

// Should use:
GET /identifiers/EPprcIy-6_tK...  // ✓ Correct
```

---

## Complete Fix for identity.ts

```typescript
import { defineStore } from 'pinia';
import { KERIClient } from '@/services/keri/client';

interface IdentityState {
  displayName: string | null;
  aid: string | null;  // Cryptographic prefix
  agentConfigured: boolean;
}

export const useIdentityStore = defineStore('identity', {
  state: (): IdentityState => ({
    displayName: null,
    aid: null,
    agentConfigured: false
  }),
  
  actions: {
    async createIdentity(displayName: string, mnemonic?: string) {
      const client = await KERIClient.getInstance();
      
      try {
        console.log(`[Identity] Creating identity for: ${displayName}`);
        
        const operation = await client.identifiers().create({
          name: displayName,
          salt: mnemonic ? await deriveSalt(mnemonic) : undefined,
          toad: 2,
          wits: await client.getWitnesses()
        });
        
        await client.waitForOperation(operation);
        
        const prefix = operation.response?.i || operation.metadata?.pre;
        
        if (!prefix) {
          throw new Error('No AID prefix returned from creation');
        }
        
        console.log(`[Identity] AID created: ${prefix}`);
        
        this.displayName = displayName;
        this.aid = prefix;
        
        try {
          await client.addAgentRole(prefix);
          this.agentConfigured = true;
          console.log('[Identity] Agent role configured');
        } catch (error) {
          console.warn('[Identity] Agent role failed:', error);
        }
        
        await this.persist();
        
        return { displayName, aid: prefix };
      } catch (error) {
        console.error('[Identity] Creation failed:', error);
        throw error;
      }
    },
    
    async loadIdentity() {
      const stored = localStorage.getItem('matou-identity');
      if (!stored) return null;
      
      const data = JSON.parse(stored);
      this.displayName = data.displayName;
      this.aid = data.aid;
      this.agentConfigured = data.agentConfigured;
      
      return data;
    },
    
    async persist() {
      localStorage.setItem('matou-identity', JSON.stringify({
        displayName: this.displayName,
        aid: this.aid,
        agentConfigured: this.agentConfigured,
        timestamp: Date.now()
      }));
    }
  }
});
```

---

## ProfileFormScreen.vue Fix

```typescript
async function handleSubmit() {
  loading.value = true;
  error.value = null;
  
  try {
    const identityStore = useIdentityStore();
    
    // Returns {displayName, aid} with aid being the prefix
    const result = await identityStore.createIdentity(
      form.displayName,
      form.mnemonic
    );
    
    console.log('Identity created:', result);
    
    // Store both for UI purposes
    sessionStorage.setItem('userDisplayName', result.displayName);
    sessionStorage.setItem('userAID', result.aid);  // The prefix
    
    router.push('/dashboard');
  } catch (err) {
    console.error('Profile creation failed:', err);
    error.value = err.message;
  } finally {
    loading.value = false;
  }
}
```

---

## API Usage Pattern Guide

### Always Use Prefix in API Calls

```typescript
// ❌ NEVER do this:
const displayName = "Please Work";
await client.identifiers().get(displayName);
await client.exchanges().sendFromEvents(displayName, ...);
await client.ipex().apply({ senderName: displayName, ... });

// ✓ ALWAYS do this:
const identity = await identityStore.loadIdentity();
const aid = identity.aid;  // "EPprcIy-6_tK..."

await client.identifiers().get(aid);
await client.exchanges().sendFromEvents(aid, ...);
await client.ipex().apply({ 
  senderName: identity.displayName,  // OK for display metadata
  sender: aid,                        // Required for protocol
  ...
});
```

### Display Name vs AID Matrix

```typescript
Context                     | Use Display Name | Use AID Prefix
----------------------------|------------------|------------------
UI rendering                | ✓                | ✗
User input                  | ✓                | ✗
Local storage keys          | ✓                | ✗
Protocol operations         | ✗                | ✓
API endpoints               | ✗                | ✓
Signature creation          | ✗                | ✓
KEL events                  | ✗                | ✓
Witness receipts            | ✗                | ✓
Exchange messages           | ✗                | ✓
IPEX credentials            | metadata only    | ✓ (sender/recipient)
Identifier creation         | ✓ (name param)   | ← Returns prefix
```

---

## Debug Checklist

### 1. Check Operation Response
```typescript
const op = await client.identifiers().create({ name: "Test" });
console.log('Operation metadata:', op.metadata);
console.log('Operation response:', op.response);
console.log('AID prefix:', op.metadata?.pre || op.response?.i);
```

### 2. Verify Identifier List
```typescript
const aids = await client.identifiers().list();
console.log('All AIDs:', aids.aids.map(a => ({
  name: a.name,
  prefix: a.prefix
})));
```

### 3. Test GET Endpoint
```typescript
// This should fail with 401
try {
  await client.identifiers().get("Please Work");
} catch (e) {
  console.log('Expected failure:', e);
}

// This should succeed
const aid = await client.identifiers().get("EPprcIy-6_tK...");
console.log('Success:', aid);
```

### 4. Check URL Construction
```typescript
const name = "Please Work";
const prefix = "EPprcIy-6_tK6rvq558X09bl04MDFd9GYtHoyt5e4-Xi";

console.log('Wrong URL:', `/identifiers/${encodeURIComponent(name)}`);
// → /identifiers/Please%20Work ❌

console.log('Right URL:', `/identifiers/${prefix}`);
// → /identifiers/EPprcIy-6_tK6rvq558X09bl04MDFd9GYtHoyt5e4-Xi ✓
```

---

## Quick Win: Validation Function

Add to client.ts:

```typescript
export class KERIClient {
  private validateAID(value: string, context: string): void {
    if (!value) {
      throw new Error(`${context}: AID is required`);
    }
    
    if (!value.startsWith('E')) {
      throw new Error(
        `${context}: Expected AID prefix (starting with 'E'), got: ${value}. ` +
        `You may be passing a display name instead of the cryptographic identifier.`
      );
    }
    
    if (value.length < 44) {
      throw new Error(
        `${context}: AID prefix too short (${value.length} chars). ` +
        `Expected base64 encoded identifier (44+ chars).`
      );
    }
  }
  
  async addAgentRole(aid: string) {
    this.validateAID(aid, 'addAgentRole');
    // ... rest of implementation
  }
  
  async sendEXN(sender: string, recipient: string, ...) {
    this.validateAID(sender, 'sendEXN.sender');
    this.validateAID(recipient, 'sendEXN.recipient');
    // ... rest of implementation
  }
}
```

This will catch the error early with clear message:
```
Error: addAgentRole: Expected AID prefix (starting with 'E'), got: Please Work.
You may be passing a display name instead of the cryptographic identifier.
```

---

## Summary

**Same issue, same fix needed:**

1. Extract AID prefix from operation response
2. Store prefix separately from display name
3. Use prefix for all API calls
4. Only use display name for UI rendering

**Immediate fix** (client.ts line 255):
```diff
- const aid = await this.client.identifiers().get(name);
+ const prefix = op.metadata?.pre || op.response?.i;
+ const aid = await this.client.identifiers().get(prefix);
```

**And line 280:**
```diff
- await this.addAgentRole(name);
+ await this.addAgentRole(prefix);
```

The 401 errors will disappear once you stop using display names in API endpoints.
