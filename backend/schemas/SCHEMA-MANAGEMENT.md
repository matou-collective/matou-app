# ACDC Schema Management

This document explains how to manage ACDC (Authentic Chained Data Containers) schemas for MATOU credential issuance.

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

## Updating a Schema

### Step 1: Edit the Schema

Make your changes to the schema file. You can leave `$id` as an empty string or placeholder - it will be replaced during SAIDification.

### Step 2: SAIDify the Schema

Run the following command to compute the new SAID:

```bash
# Copy schema to KERIA container, SAIDify, and save back
cat backend/schemas/matou-membership-schema.json | \
  docker exec -i matou-keria tee /tmp/schema.json > /dev/null && \
  docker exec matou-keria kli saidify --file /tmp/schema.json --label '$id' && \
  docker exec matou-keria cat /tmp/schema.json | python3 -m json.tool > backend/schemas/matou-membership-schema.json
```

### Step 3: Get the New SAID

```bash
grep '"\$id"' backend/schemas/matou-membership-schema.json
# Output: "$id": "EOVL3N0K_tYc9U-HXg7r2jDPo4Gnq3ebCjDqbJzl6fsT",
```

### Step 4: Update References

Update `SCHEMA_SAID` in `infrastructure/scripts/issue-credentials.py`:

```python
SCHEMA_SAID = "EOVL3N0K_tYc9U-HXg7r2jDPo4Gnq3ebCjDqbJzl6fsT"  # Your new SAID
```

### Step 5: Restart Schema Server

The schema server caches schemas on startup. Restart it to pick up changes:

```bash
pkill -f schema-server.py
cd infrastructure/scripts && python3 schema-server.py &
```

### Step 6: Re-resolve Schema OOBI

KERIA caches resolved schemas. When issuing credentials with the updated schema, the OOBI will be re-resolved automatically (new SAID = new OOBI URL).

## Schema Server

The schema server (`infrastructure/scripts/schema-server.py`) serves schemas at `/oobi/{SAID}` endpoints, mimicking the vLEI server format required by `kli oobi resolve`.

```bash
# Start the schema server (required for credential issuance)
cd infrastructure/scripts
python3 schema-server.py --port 7723 --host 0.0.0.0
```

Available endpoints:
- `GET /` - List all available schemas
- `GET /oobi/{SAID}` - Get schema by SAID

## Current Schemas

| Schema | SAID | Description |
|--------|------|-------------|
| matou-membership-schema.json | `EOVL3N0K_tYc9U-HXg7r2jDPo4Gnq3ebCjDqbJzl6fsT` | Membership credential with role and permissions |

## Troubleshooting

### "Schema not found" error during credential issuance

1. Ensure schema server is running: `curl http://localhost:7723/`
2. Verify SAID matches: `grep '$id' backend/schemas/your-schema.json`
3. Check KERIA can reach schema server: `docker exec matou-keria curl http://172.17.0.1:7723/`

### Schema validation fails

- Ensure schema includes all ACDC envelope fields (`v`, `d`, `i`, `ri`, `s`, `a`)
- Check that `required` arrays are correct at both root and `a` (attributes) levels
- Verify `additionalProperties: false` if you want strict validation

## References

- [vLEI Schema Repository](https://github.com/WebOfTrust/vLEI)
- [ACDC Specification](https://weboftrust.github.io/vc-acdc/)
- [KERI Tutorial on ACDCs](https://kentbull.com/2023/03/09/keri-tutorial-series-treasure-hunting-in-abydos-issuing-and-verifying-a-credential-acdc/)
