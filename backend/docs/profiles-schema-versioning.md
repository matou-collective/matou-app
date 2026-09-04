# Profile schema versioning

_How existing member profiles behave when an admin edits the org's profile
schema. Issue #302, part of #180 (slice 5)._

## Policy: migrate-on-write, grandfather-on-read

An org admin can edit the profile schema (add/remove non-core fields, tighten
validation, constrain a field to an enum, add variants). Existing member
profiles were written under the schema as it stood at the time. This document
defines what happens to them after such an edit.

The decision — endorsed by the issue ("grandfather until next write is the
obvious call") — is:

- **Migrate on write.** Every profile write stamps the current schema version
  into the stored data. A profile that predated an edit is migrated the next
  time its owner saves it. There is no bulk/offline migration pass.
- **Grandfather on read.** A profile below the live schema version still loads.
  Reads tolerate a missing newly-required field rather than erroring; the value
  present in the profile is still validated, and fields the admin removed stay
  inert (never rejected, never dropped).

This keeps writes strict (data going in is valid against the current schema)
without locking existing members out of the app the moment an admin adds a
required field.

## Version-bump semantics

`TypeDefinition.Version` is the schema version. An admin schema edit bumps it
**only when the change affects what data validates**:

- field set (a field added or removed),
- any field's validation-relevant attributes (type, required, readOnly, core,
  default, validation rules),
- the variant field or any variant's field set.

Cosmetic edits — labels, placeholders, sections and other UI hints, layouts,
description, permissions — and field **reordering** do **not** bump the version.

`types.SchemaChanged(oldDef, newDef)` reports whether an edit is substantive;
`types.VersionForEdit(oldDef, newDef)` returns the version the edited definition
should carry (`old` for a cosmetic edit, `old+1` for a substantive one).

## Staleness

Profiles carry a core, read-only `typeVersion` field recording the schema
version they were last written under.

- `types.SchemaVersion(data)` reads it (0 for a pre-versioning profile).
- `def.IsStale(data)` reports whether a profile predates the live schema version
  (i.e. was not re-written since the edit).

## Read vs write validation

| Path  | Function                | Newly-required field missing | Present value | Removed/unknown field |
|-------|-------------------------|------------------------------|---------------|-----------------------|
| Read  | `types.ValidateForRead` | grandfathered (no error)     | validated     | inert (no error)      |
| Write | `types.ValidateData`    | **rejected** (asked for)     | validated     | inert (no error)      |

So an admin adds a required field →

1. every existing member still loads (read grandfathers the missing value), and
2. each member is asked for the new field on their **next** profile save (the
   strict write validation rejects a save that still omits it).

## Migration on write

`types.StampVersion(def, data)` sets `typeVersion` to the live version and is a
no-op for types that do not declare a `typeVersion` field. `HandleCreateProfile`
calls it after validation on every profile write, overwriting any stale value a
client sends, so a successful save migrates the profile — it is no longer stale.
Profile seeding (org setup and member init) stamps the live version too, so a
freshly-seeded profile is never born stale.

## Where this lives

- `backend/internal/types/versioning.go` — `SchemaChanged`, `VersionForEdit`,
  `SchemaVersion`, `IsStale`, `StampVersion`, `ValidateForRead`.
- `backend/internal/types/validate.go` — strict `ValidateData` (write path).
- `backend/internal/api/profiles.go` — stamping on write; live-version seeding.
- Tests: `backend/internal/types/profiles_versioning_test.go`,
  `backend/internal/api/profiles_versioning_test.go`.

## Out of scope

Frontend form handling for a newly-required field (prompting the member on their
next save) is tracked separately in #181. This slice defines and enforces the
backend behaviour the frontend builds on.
