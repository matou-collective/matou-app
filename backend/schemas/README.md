# ACDC Schemas

This directory contains ACDC (Authentic Chained Data Containers) schemas for MATOU credential issuance.

## Quick Start

1. Create a new `.json` schema file in this directory
2. SAIDify it (see below)
3. Restart the schema server - it automatically loads all schemas from this folder
4. Update the frontend credential issuance code with the new SAID if needed

## Understanding SAIDs

A **SAID** (Self-Addressing IDentifier) is a cryptographic hash of the schema content stored in the `$id` field. This ensures schema integrity - anyone can verify that the schema they received matches the identifier.

**Important:** If you change anything in a schema, you must re-SAIDify it to compute a new `$id`.

## Schema Structure

ACDC schemas must include the full credential envelope structure, not just the attribute fields:

```json
{
  "$id": "E...",           // SAID (computed hash)
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object",
  "properties": {
    "v": { "type": "string" },      // Version
    "d": { "type": "string" },      // Credential SAID
    "u": { "type": "string" },      // Nonce (optional, for privacy)
    "i": { "type": "string" },      // Issuer AID
    "ri": { "type": "string" },     // Registry ID
    "s": { "type": "string" },      // Schema SAID
    "a": {                          // Attributes block
      "oneOf": [
        { "type": "string" },       // SAID reference
        {
          "type": "object",
          "properties": {
            "d": { "type": "string" },   // Attributes SAID
            "i": { "type": "string" },   // Recipient AID
            "dt": { "type": "string" },  // Issuance datetime
            // ... your custom fields here
          }
        }
      ]
    }
  },
  "required": ["v", "d", "i", "ri", "s", "a"]
}
```

## Adding a New Schema

### Step 1: Create the Schema File

Create a new `.json` file in this directory (e.g., `my-new-credential-schema.json`).

Use the template below, replacing the attributes in the `a` block with your custom fields:

```json
{
  "$id": "",
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "My New Credential",
  "description": "Description of what this credential represents",
  "type": "object",
  "credentialType": "MyNewCredential",
  "version": "1.0.0",
  "properties": {
    "v": { "description": "Version string", "type": "string" },
    "d": { "description": "Credential SAID", "type": "string" },
    "u": { "description": "Nonce (optional)", "type": "string" },
    "i": { "description": "Issuer AID", "type": "string" },
    "ri": { "description": "Registry ID", "type": "string" },
    "s": { "description": "Schema SAID", "type": "string" },
    "a": {
      "oneOf": [
        { "description": "Attributes SAID", "type": "string" },
        {
          "description": "Attributes block",
          "type": "object",
          "properties": {
            "d": { "description": "Attributes SAID", "type": "string" },
            "i": { "description": "Recipient AID", "type": "string" },
            "dt": { "description": "Issuance datetime", "type": "string", "format": "date-time" },
            "myField1": { "description": "Your custom field", "type": "string" },
            "myField2": { "description": "Another custom field", "type": "number" }
          },
          "additionalProperties": false,
          "required": ["d", "i", "dt", "myField1", "myField2"]
        }
      ]
    }
  },
  "additionalProperties": false,
  "required": ["v", "d", "i", "ri", "s", "a"]
}
```

### Step 2: SAIDify the Schema

The `matou-keria` container is from the KERI infrastructure (`infrastructure/keri/`). Ensure the KERI stack is running before running SAIDify commands.

```bash
# SAIDify your new schema (requires KERI infrastructure running)
cat backend/schemas/my-new-credential-schema.json | \
  docker exec -i matou-keri-keria-1 tee /tmp/schema.json > /dev/null && \
  docker exec matou-keri-keria-1 kli saidify --file /tmp/schema.json --label '$id' && \
  docker exec matou-keri-keria-1 cat /tmp/schema.json | python3 -m json.tool > backend/schemas/my-new-credential-schema.json
```

### Step 3: Restart Schema Server

The schema server automatically loads all `.json` files from this directory that have a valid SAID (starting with 'E') in the `$id` field.

```bash
cd infrastructure/keri && make restart
```

### Step 4: Verify Schema is Loaded

```bash
curl http://localhost:7723/
# Should list your new schema's SAID in the endpoints
```

### Step 5: Use in Credential Issuance

Update the `MEMBERSHIP_SCHEMA_SAID` constant in all frontend composables that reference it:
- `frontend/src/composables/useOrgSetup.ts`
- `frontend/src/composables/usePreCreatedInvite.ts`
- `frontend/src/composables/useAdminActions.ts`
- `frontend/src/composables/useCredentialPolling.ts`

---

## Updating a Schema

### Step 1: Edit the Schema

Make your changes to the schema file. You can leave `$id` as an empty string or placeholder - it will be replaced during SAIDification.

### Step 2: SAIDify the Schema

Run the following command to compute the new SAID:

```bash
# Copy schema to KERIA container, SAIDify, and save back
cat backend/schemas/matou-membership-schema.json | \
  docker exec -i matou-keri-keria-1 tee /tmp/schema.json > /dev/null && \
  docker exec matou-keri-keria-1 kli saidify --file /tmp/schema.json --label '$id' && \
  docker exec matou-keri-keria-1 cat /tmp/schema.json | python3 -m json.tool > backend/schemas/matou-membership-schema.json
```

### Step 3: Get the New SAID

```bash
grep '"\$id"' backend/schemas/matou-membership-schema.json
# Output: "$id": "ECg6npd1vQ5mEnoLrsK7DG72gHJXklSa61Ybh559wZOI",
```

### Step 4: Update References

Update `MEMBERSHIP_SCHEMA_SAID` in the frontend composables:

```typescript
// In frontend/src/composables/useOrgSetup.ts (and other composables listed above)
const MEMBERSHIP_SCHEMA_SAID = "ECg6npd1vQ5mEnoLrsK7DG72gHJXklSa61Ybh559wZOI";
```

### Step 5: Restart Schema Server

The schema server caches schemas on startup. Restart it to pick up changes:

```bash
cd infrastructure/keri && make restart
```

### Step 6: Re-resolve Schema OOBI

KERIA caches resolved schemas. When issuing credentials with the updated schema, the OOBI will be re-resolved automatically (new SAID = new OOBI URL).

## Schema Server

The schema server (`infrastructure/scripts/schema-server.py`) serves schemas at `/oobi/{SAID}` endpoints, mimicking the vLEI server format required by `kli oobi resolve`.

**Auto-loading:** The server automatically loads all `.json` files from `backend/schemas/` that have a valid SAID (starting with 'E') in the `$id` field. Simply add a new schema file and restart the server.

```bash
# The schema server runs as a Docker container in the KERI infrastructure
# To run locally:
cd infrastructure/scripts
python3 schema-server.py --port 7723 --host 0.0.0.0
```

Available endpoints:
- `GET /` - List all loaded schemas and their endpoints
- `GET /oobi/{SAID}` - Get schema by SAID

Example:
```bash
# List all schemas
curl http://localhost:7723/

# Get a specific schema
curl http://localhost:7723/oobi/ECg6npd1vQ5mEnoLrsK7DG72gHJXklSa61Ybh559wZOI
```

## Current Schemas

| Schema | SAID | Description |
|--------|------|-------------|
| matou-membership-schema.json | `ECg6npd1vQ5mEnoLrsK7DG72gHJXklSa61Ybh559wZOI` | Membership credential v2 with community name, role, and join date |
| operations-steward-schema.json | `EOperationsStewardSchemaV1` (placeholder, not SAIDified) | Operations Steward role credential with admin permissions |

> **Note**: `operations-steward-schema.json` has a placeholder `$id`, not a real SAID. It needs to be SAIDified before use in credential issuance.

## Troubleshooting

### "Schema not found" error during credential issuance

1. Ensure schema server is running: `curl http://localhost:7723/`
2. Verify SAID matches: `grep '$id' backend/schemas/your-schema.json`
3. Check KERIA can reach schema server: `docker exec matou-keri-keria-1 curl http://172.17.0.1:7723/`

### Schema validation fails

- Ensure schema includes all ACDC envelope fields (`v`, `d`, `i`, `ri`, `s`, `a`)
- Check that `required` arrays are correct at both root and `a` (attributes) levels
- Verify `additionalProperties: false` if you want strict validation

## References

- [vLEI Schema Repository](https://github.com/WebOfTrust/vLEI)
- [ACDC Specification](https://weboftrust.github.io/vc-acdc/)
- [KERI Tutorial on ACDCs](https://kentbull.com/2023/03/09/keri-tutorial-series-treasure-hunting-in-abydos-issuing-and-verifying-a-credential-acdc/)
