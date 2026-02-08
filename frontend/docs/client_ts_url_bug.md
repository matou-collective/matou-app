# Critical Bug: client.ts Still Using Display Names in URLs

## The Problem

Despite having `resolveAID()` that correctly resolves display names to prefixes, **the code is still passing display names directly to SignifyClient API calls**, which construct URLs like:

```
POST /identifiers/Please%20Work/exchanges  ❌
```

Instead of:
```
POST /identifiers/EPprcIy-6_tK6rvq558X09bl04MDFd9GYtHoyt5e4-Xi/exchanges  ✓
```

---

## Root Cause Analysis

### Your Logs Show:

```javascript
// Line 1085: You resolved AIDs correctly
[KERIClient] Sender AID: EPprcIy-6_tK6rvq558X09bl04MDFd9GYtHoyt5e4-Xi
[KERIClient] Recipient AID: EO78r6CUbe7zlCkrG2IZ_buNQtH7njtPKMI65KBMUX1m

// Line 1090: But then GET still uses display name
GET /identifiers/Please%20Work 401

// Line 1120: And POST still uses display name in URL
POST /identifiers/Please%20Work/exchanges 401
```

**This means:**
1. `resolveAID()` is working and returning correct prefixes
2. But those prefixes are **not being used** in the actual SignifyClient calls
3. Something is passing the original display name to SignifyClient methods

---

## The Bug in client.ts

Looking at the error stack trace:

```
sendEXN @ client.ts:1120
↓
await this.client.exchanges().sendFromEvents(...)
```

**The issue is in line 1120.** The `sendFromEvents()` method is receiving the wrong identifier.

### Incorrect Code Pattern (Current)

```typescript
async sendEXN(sender: string, recipient: string, route: string, payload?: any) {
  // ✓ Resolves correctly
  const senderAid = await this.resolveAID(sender);
  const recipientAid = await this.resolveAID(recipient);
  
  console.log('[KERIClient] Sender AID:', senderAid);
  console.log('[KERIClient] Recipient AID:', recipientAid);
  
  // ✓ Gets identifier object
  const identifier = await this.client.identifiers().get(senderAid);
  
  // ❌ BUG: Passes identifier.name instead of senderAid
  await this.client.exchanges().sendFromEvents(
    identifier.name,  // ← This is "Please Work", not the prefix!
    route,
    { recipient: recipientAid, ...payload }
  );
}
```

### The SignifyClient API

The SignifyClient library expects **AID prefixes**, not names:

```typescript
// SignifyClient internal implementation
class Exchanges {
  async sendFromEvents(aid: string, route: string, payload: any) {
    // Constructs URL directly from aid parameter
    const url = `/identifiers/${aid}/exchanges`;
    //                           ^^^^
    // If aid="Please Work", URL becomes /identifiers/Please%20Work/exchanges
    // If aid="EPprcIy...", URL becomes /identifiers/EPprcIy.../exchanges
    
    return await this.client.fetch('POST', url, payload);
  }
}
```

---

## Complete Fix for client.ts

### Fix 1: sendEXN Method

```typescript
async sendEXN(sender: string, recipient: string, route: string, payload?: any) {
  const senderAid = await this.resolveAID(sender);
  const recipientAid = await this.resolveAID(recipient);
  
  console.log('[KERIClient] Creating EXN message for route:', route);
  console.log('[KERIClient] Sender AID:', senderAid, 'Recipient AID:', recipientAid);
  
  try {
    await this.ensureConnected();
    
    // ✓ CRITICAL FIX: Use senderAid (prefix), not identifier.name
    const result = await this.client.exchanges().sendFromEvents(
      senderAid,  // ← Must be prefix like "EPprcIy..."
      route,
      { 
        recipient: recipientAid,
        ...payload 
      }
    );
    
    console.log('[KERIClient] EXN sent successfully');
    return result;
    
  } catch (error: any) {
    console.error('[KERIClient] Failed to send EXN:', error);
    
    if (error.message?.includes('401')) {
      console.log('[KERIClient] Got 401, reconnecting and retrying...');
      await this.reconnect();
      
      // Retry with same prefix
      return await this.client.exchanges().sendFromEvents(
        senderAid,  // ← Still use prefix, not name
        route,
        { recipient: recipientAid, ...payload }
      );
    }
    
    throw error;
  }
}
```

### Fix 2: IPEX Apply

```typescript
async sendRegistrationToAdmins(sender: string, admins: string[]) {
  const senderAid = await this.resolveAID(sender);
  
  for (const admin of admins) {
    const adminAid = await this.resolveAID(admin);
    
    console.log(`[KERIClient] Sending registration EXN to ${adminAid}...`);
    
    try {
      // Send EXN
      const exnResult = await this.sendEXN(
        senderAid,  // Already prefix
        adminAid,   // Already prefix
        '/matou/registration/apply'
      );
      
      console.log('[KERIClient] Custom EXN result:', exnResult);
      
      // Send IPEX apply
      console.log(`[KERIClient] Sending IPEX apply to ${adminAid}...`);
      
      try {
        // ✓ FIX: Get identifier to extract name for IPEX
        const identifier = await this.client.identifiers().get(senderAid);
        
        await this.client.ipex().apply({
          senderName: identifier.name,  // OK: IPEX needs name for internal lookup
          recipient: adminAid,           // But recipient must be prefix
          schema: 'EBfdlu8R27Fbx-ehrqwImnK-8Cm79sqbAQ4MmvEAYqao',
          attributes: {}
        });
        
        console.log('[KERIClient] IPEX apply sent successfully');
        
      } catch (ipexError: any) {
        console.log('[KERIClient] IPEX apply failed (continuing with EXN):', ipexError);
      }
      
      console.log(`[KERIClient] Registration sent to admin ${adminAid}`);
      
    } catch (error) {
      console.error(`[KERIClient] Failed for admin ${admin}:`, error);
      continue;
    }
  }
}
```

### Fix 3: resolveAID Should Not Call identifiers().get()

The 401 errors in `resolveAID` suggest it's trying to verify the AID exists, but this fails:

```typescript
async resolveAID(nameOrAid: string): Promise<string> {
  // Already a prefix - return as is
  if (nameOrAid.startsWith('E') && nameOrAid.length > 40) {
    return nameOrAid;
  }
  
  // Check cache
  if (this.identifierCache.has(nameOrAid)) {
    return this.identifierCache.get(nameOrAid)!;
  }
  
  // Resolve from list
  console.log(`[KERIClient] Resolving AID for name: ${nameOrAid}`);
  
  try {
    const identifiers = await this.client.identifiers().list();
    const match = identifiers.aids.find(aid => aid.name === nameOrAid);
    
    if (!match) {
      throw new Error(`No AID found for name: ${nameOrAid}`);
    }
    
    console.log(`[KERIClient] Resolved ${nameOrAid} → ${match.prefix}`);
    this.identifierCache.set(nameOrAid, match.prefix);
    return match.prefix;
    
  } catch (error) {
    console.error(`[KERIClient] Failed to resolve ${nameOrAid}:`, error);
    throw error;
  }
}
```

**Remove these lines from resolveAID:**
```typescript
// ❌ DELETE THIS - causes 401
try {
  const aid = await this.client.identifiers().get(nameOrAid);
  return aid.prefix;
} catch (error) {
  console.log('[KERIClient] get failed, trying list():', error);
}
```

The `get()` call expects a prefix, so calling it with a name causes 401.

---

## Complete Working Implementation

### client.ts (Full Methods)

```typescript
export class KERIClient {
  private client: SignifyClient;
  private identifierCache = new Map<string, string>();
  
  async resolveAID(nameOrAid: string): Promise<string> {
    if (nameOrAid.startsWith('E') && nameOrAid.length > 40) {
      return nameOrAid;
    }
    
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
    console.log('[KERIClient] Sender AID:', senderAid, 'Recipient AID:', recipientAid);
    console.log('[KERIClient] EXN details:', {
      sender: senderAid,
      recipient: recipientAid,
      route
    });
    
    try {
      await this.ensureConnected();
      
      console.log(`[KERIClient] Sending EXN to ${recipientAid}...`);
      
      const result = await this.client.exchanges().sendFromEvents(
        senderAid,
        route,
        { recipient: recipientAid, ...payload }
      );
      
      console.log('[KERIClient] EXN sent successfully');
      return { success: true, result };
      
    } catch (error: any) {
      console.error('[KERIClient] Failed to send EXN:', error);
      
      if (error.message?.includes('401')) {
        console.log('[KERIClient] Got 401, reconnecting and retrying...');
        await this.reconnect();
        
        try {
          const result = await this.client.exchanges().sendFromEvents(
            senderAid,
            route,
            { recipient: recipientAid, ...payload }
          );
          
          console.log('[KERIClient] Retry succeeded');
          return { success: true, result };
          
        } catch (retryError: any) {
          console.error('[KERIClient] Retry failed:', retryError);
          return { success: false, error: retryError.message };
        }
      }
      
      return { success: false, error: error.message };
    }
  }
  
  async sendRegistrationToAdmins(sender: string, admins: string[]) {
    const senderAid = await this.resolveAID(sender);
    
    for (const admin of admins) {
      const adminAid = await this.resolveAID(admin);
      
      console.log(`[KERIClient] Sending registration EXN to ${adminAid}...`);
      
      const exnResult = await this.sendEXN(
        senderAid,
        adminAid,
        '/matou/registration/apply'
      );
      
      console.log('[KERIClient] Custom EXN result:', exnResult);
      
      console.log(`[KERIClient] Sending IPEX apply to ${adminAid}...`);
      
      try {
        const identifiers = await this.client.identifiers().list();
        const senderIdentifier = identifiers.aids.find(aid => aid.prefix === senderAid);
        
        if (!senderIdentifier) {
          throw new Error(`Cannot find identifier for AID ${senderAid}`);
        }
        
        await this.client.ipex().apply({
          senderName: senderIdentifier.name,
          recipient: adminAid,
          schema: 'EBfdlu8R27Fbx-ehrqwImnK-8Cm79sqbAQ4MmvEAYqao',
          attributes: {}
        });
        
        console.log('[KERIClient] IPEX apply sent successfully');
        
      } catch (ipexError: any) {
        console.log('[KERIClient] IPEX apply failed (continuing with EXN):', ipexError);
      }
      
      console.log(`[KERIClient] Registration sent to admin ${adminAid}`);
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
    console.log('[KERIClient] Reconnected successfully');
  }
}
```

---

## Why This Happens: SignifyClient API Design

The SignifyClient library has an inconsistent API:

```typescript
// Some methods accept NAME:
await client.identifiers().create({ name: "Please Work" })
await client.ipex().apply({ senderName: "Please Work", ... })

// But most methods need PREFIX:
await client.identifiers().get(prefix)  // Not name!
await client.exchanges().sendFromEvents(prefix, ...)  // Not name!
await client.identifiers().addEndRole(prefix, ...)  // Not name!
```

This is why you need `resolveAID()` - to translate names to prefixes before calling most SignifyClient methods.

---

## Testing Verification

After applying fixes, you should see:

```
[KERIClient] Sender AID: EPprcIy-6_tK6rvq558X09bl04MDFd9GYtHoyt5e4-Xi
[KERIClient] Recipient AID: EO78r6CUbe7zlCkrG2IZ_buNQtH7njtPKMI65KBMUX1m
[KERIClient] Sending EXN to EO78r6CUbe7zlCkrG2IZ_buNQtH7njtPKMI65KBMUX1m...

POST /identifiers/EPprcIy-6_tK6rvq558X09bl04MDFd9GYtHoyt5e4-Xi/exchanges
200 OK  ✓

[KERIClient] EXN sent successfully
```

No more `Please%20Work` in URLs, no more 401 errors.

---

## Summary of Required Changes

1. **Line ~1120**: Change `sendFromEvents(identifier.name, ...)` → `sendFromEvents(senderAid, ...)`
2. **Line ~452**: Remove `await this.client.identifiers().get(nameOrAid)` from `resolveAID()`
3. **Line ~1308**: Get identifier from list, not from `get(name)`, before calling `ipex().apply()`

The core issue: **You're resolving to prefixes but then throwing them away and using names instead.**
