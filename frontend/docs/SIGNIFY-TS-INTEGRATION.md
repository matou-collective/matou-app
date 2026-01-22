# signify-ts Integration

This document details the integration of signify-ts into the Matou frontend for real KERI functionality.

## Overview

The frontend uses [signify-ts](https://github.com/WebOfTrust/signify-ts) to communicate with KERIA (KERI Agent) for:
- Agent bootstrapping and connection
- AID (Autonomic Identifier) creation
- OOBI (Out-of-Band Introduction) resolution
- Credential management (future)

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      Frontend (Vue/Quasar)                   │
├─────────────────────────────────────────────────────────────┤
│  RegistrationScreen.vue    │    CredentialIssuanceScreen    │
│          ↓                 │              ↓                  │
│  useIdentityStore()        │    useIdentityStore()          │
│          ↓                 │              ↓                  │
├─────────────────────────────────────────────────────────────┤
│                    Identity Store (Pinia)                    │
│  - connect(passcode)       - createIdentity(name)           │
│  - restore()               - disconnect()                    │
│          ↓                                                   │
├─────────────────────────────────────────────────────────────┤
│                    KERIClient (src/lib/keri/client.ts)       │
│  - initialize(bran)        - createAID(name)                │
│  - resolveWitnessOOBIs()   - listAIDs()                     │
│          ↓                                                   │
├─────────────────────────────────────────────────────────────┤
│                    signify-ts (SignifyClient)                │
│          ↓                         ↓                         │
│    localhost:3901           localhost:3903                   │
│    (KERIA Admin API)        (KERIA Boot API)                │
└─────────────────────────────────────────────────────────────┘
```

## Key Files

| File | Purpose |
|------|---------|
| `src/lib/keri/client.ts` | KERIClient wrapper around signify-ts |
| `src/stores/identity.ts` | Pinia store for identity state management |
| `src/lib/api/client.ts` | Backend API client for sync operations |
| `src/boot/keri.ts` | Auto-restore session on app startup |

## Connection Flow

### 1. Initialization

```typescript
// In RegistrationScreen.vue
const passcode = KERIClient.generatePasscode();
await identityStore.connect(passcode);
```

### 2. Boot or Connect

The KERIClient handles both new and returning users:

```typescript
async initialize(bran: string): Promise<void> {
  await ready(); // Initialize libsodium
  this.client = new SignifyClient(keriaUrl, bran, Tier.low, keriaBootUrl);

  try {
    await this.client.connect(); // Try existing agent
  } catch (err) {
    if (err.message.includes('agent does not exist')) {
      await this.client.boot();  // Create new agent
      await this.client.connect();
    }
  }
}
```

### 3. OOBI Resolution

Before creating AIDs with witnesses, witness OOBIs must be resolved:

```typescript
const witnessOOBIs = [
  'http://witness1:5643/oobi',
  'http://witness2:5645/oobi',
  'http://witness3:5647/oobi',
];

for (const oobi of witnessOOBIs) {
  const op = await this.client.oobis().resolve(oobi);
  await this.client.operations().wait(op);
}
```

### 4. AID Creation

```typescript
const result = await this.client.identifiers().create(name, {
  toad: 2,  // 2-of-3 witness threshold
  wits: witnesses,
});
const op = await result.op();
await this.client.operations().wait(op);
```

## Configuration

### Vite Configuration

signify-ts requires special bundling configuration for libsodium:

```typescript
// quasar.config.ts
extendViteConf(viteConf) {
  viteConf.optimizeDeps.include.push(
    'signify-ts',
    'libsodium-wrappers-sumo',
    'libsodium-sumo'
  );

  viteConf.resolve.alias = {
    'libsodium-wrappers-sumo': path.join(
      __dirname,
      'node_modules/libsodium-wrappers-sumo/dist/modules-sumo/libsodium-wrappers.js'
    ),
  };
}
```

### CORS Handling

For development, Chrome is launched with disabled web security in Playwright tests:

```typescript
// playwright.config.ts
launchOptions: {
  args: [
    '--disable-web-security',
    '--disable-features=IsolateOrigins,site-per-process',
  ],
}
```

For production, use a reverse proxy (nginx) to add CORS headers to KERIA responses.

## Witness Configuration

The witnesses are configured in the KERI infrastructure:

| Witness | Docker Host | Port | AID |
|---------|-------------|------|-----|
| witness1 | witness1:5643 | 5643 | `BLskRTInXnMxWaGqcpSyMgo0nYbalW99cGZESrz3zapM` |
| witness2 | witness2:5645 | 5645 | `BM35JN8XeJSEfpxopjn5jr7tAHCE5749f0OobhMLCorE` |
| witness3 | witness3:5647 | 5647 | `BF2rZTW79z4IXocYRQnjjsOuvFUQv-ptCf8Yltd7PfsM` |

**Note**: Witness AIDs are dynamically generated when the infrastructure starts. These must be updated if infrastructure is recreated.

## Session Persistence

The passcode (bran) is stored in localStorage for session restoration:

```typescript
// On connect
localStorage.setItem('matou_passcode', bran);

// On boot (src/boot/keri.ts)
const savedPasscode = localStorage.getItem('matou_passcode');
if (savedPasscode) {
  await identityStore.restore();
}
```

**Security Note**: In production, encrypt the passcode before storing.

## Error Handling

Common errors and solutions:

| Error | Cause | Solution |
|-------|-------|----------|
| `agent does not exist for controller` | New passcode, no agent | Call `boot()` before `connect()` |
| `unknown witness` | Witness OOBI not resolved | Resolve witness OOBIs first |
| `HTTP GET /identifiers/... - 401` | Name with special chars | Use `list()` and filter by name |
| `net::ERR_FAILED` on `/identifiers` | CORS blocked | Use proxy or disable web security |

## Testing

### E2E Tests

```bash
# Run all tests
npm run test

# Run with visible browser
npm run test:headed

# Debug mode
npm run test:debug
```

### Test Flow

1. **Services healthy**: Verifies backend is running
2. **Complete registration flow**: Full KERI AID creation
3. **Invite code flow**: Validates invite codes
4. **Form validation**: Tests required fields

## Development vs Production

| Aspect | Development | Production |
|--------|-------------|------------|
| AIDs | Without witnesses (faster) | With 2-of-3 witness threshold |
| CORS | Chrome flags or proxy | Reverse proxy with headers |
| Passcode storage | Plain localStorage | Encrypted storage |
| KERIA URLs | localhost:3901/3903 | Environment variables |

## Future Enhancements

1. **Credential Issuance**: Issue ACDC credentials via signify-ts
2. **Witness-backed AIDs**: Enable for production deployments
3. **Multi-sig Support**: Implement threshold signatures
4. **Credential Exchange**: IPEX protocol for credential presentation

## References

- [signify-ts GitHub](https://github.com/WebOfTrust/signify-ts)
- [KERI Specification](https://weboftrust.github.io/ietf-keri/draft-ssmith-keri.html)
- [KERIA Documentation](https://github.com/WebOfTrust/keria)
- [Matou Architecture](../../Keri-AnySync-Research/MATOU-ARCHITECTURE.md)
