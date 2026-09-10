#!/usr/bin/env bash
# Distribute an already-uploaded TestFlight build to the open (external) test
# group — the iOS counterpart of scripts/android/play-upload.sh.
#
#   scripts/ios/testflight-release.sh [--dry-run]
#
# altool's upload (build.yml "Upload to TestFlight") only parks the IPA in
# App Store Connect; testers see nothing until the build is assigned to a
# beta group and (for external groups) passes Beta App Review. This script
# closes that gap over the App Store Connect API v1 with bash + openssl +
# curl + python3 — deliberately no fastlane/Ruby, same reasoning as
# play-upload.sh.
#
# What it does, in order:
#   1. waits for the uploaded build (matched by CFBundleShortVersionString +
#      CFBundleVersion) to leave the PROCESSING state
#   2. checks export compliance is answered (baked into Info.plist via
#      ITSAppUsesNonExemptEncryption/ITSEncryptionExportComplianceCode —
#      if it is missing the build would stall in "Missing Compliance")
#   3. writes the "What to Test" notes on the build's beta localizations
#   4. submits the build for Beta App Review (external groups need it;
#      an already-submitted/approved build is treated as success)
#   5. adds the build to the external group ($TESTFLIGHT_GROUP)
#
# Credentials (the same App Store Connect API key altool uses; App Manager):
#   APPLE_API_KEY_ID        key id
#   APPLE_API_ISSUER        issuer id
#   APPLE_API_KEY_CONTENT   the .p8 *content*  — or —
#   APPLE_API_KEY           path to the .p8 on disk
#
# Knobs:
#   TESTFLIGHT_BUNDLE_ID    default nz.matou.app
#   TESTFLIGHT_GROUP        default "Open Beta" (must exist in App Store
#                           Connect; its public link is managed there)
#   TESTFLIGHT_NOTES        "What to Test" text (default: annotated tag
#                           subject, like play-upload.sh)
#   TESTFLIGHT_TIMEOUT      seconds to wait for processing (default 1800)
#   MATOU_VERSION_NAME      e.g. 0.6.2  (CFBundleShortVersionString)
#   MATOU_VERSION_CODE      e.g. 6002   (CFBundleVersion)
#
# --dry-run authenticates, resolves the app, and prints the beta groups and
# the most recent builds with their processing/review state — no mutations.
# Run it via workflow_dispatch to confirm group names against the account
# instead of guessing.
set -euo pipefail

DRY_RUN=0
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    -h|--help) sed -n '2,45p' "$0"; exit 0 ;;
    *) echo "ERROR: unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

BUNDLE_ID="${TESTFLIGHT_BUNDLE_ID:-nz.matou.app}"
GROUP_NAME="${TESTFLIGHT_GROUP:-Open Beta}"
TIMEOUT="${TESTFLIGHT_TIMEOUT:-1800}"
API="https://api.appstoreconnect.apple.com/v1"

if [ "$DRY_RUN" = "0" ]; then
  : "${MATOU_VERSION_NAME:?set MATOU_VERSION_NAME (e.g. 0.6.2)}"
  : "${MATOU_VERSION_CODE:?set MATOU_VERSION_CODE (e.g. 6002)}"
fi
: "${APPLE_API_KEY_ID:?set APPLE_API_KEY_ID}"
: "${APPLE_API_ISSUER:?set APPLE_API_ISSUER}"

# --- scratch space, wiped on any exit ---------------------------------------
TMP="$(mktemp -d)"
chmod 700 "$TMP"
trap 'rm -rf "$TMP"' EXIT

KEY_P8="$TMP/authkey.p8"
if [ -n "${APPLE_API_KEY_CONTENT:-}" ]; then
  ( umask 077; printf '%s\n' "$APPLE_API_KEY_CONTENT" > "$KEY_P8" )
elif [ -n "${APPLE_API_KEY:-}" ]; then
  [ -f "$APPLE_API_KEY" ] || { echo "ERROR: APPLE_API_KEY=$APPLE_API_KEY not found" >&2; exit 1; }
  ( umask 077; cat "$APPLE_API_KEY" > "$KEY_P8" )
else
  echo "ERROR: set APPLE_API_KEY_CONTENT or APPLE_API_KEY" >&2
  exit 1
fi

# --- ES256 JWT ---------------------------------------------------------------
# App Store Connect tokens are capped at 20 minutes; the processing wait can
# outlive that, so tokens are re-minted on demand.
b64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }

TOKEN=""
TOKEN_BORN=0
mint_token() {
  local now header claim signing_input sig
  now="$(date +%s)"
  header="$(printf '{"alg":"ES256","kid":"%s","typ":"JWT"}' "$APPLE_API_KEY_ID")"
  claim="$(printf '{"iss":"%s","iat":%s,"exp":%s,"aud":"appstoreconnect-v1"}' \
    "$APPLE_API_ISSUER" "$now" "$((now + 1140))")"
  signing_input="$(printf '%s' "$header" | b64url).$(printf '%s' "$claim" | b64url)"
  # openssl emits an ASN.1 DER ECDSA signature; JWTs need the raw 64-byte r||s.
  sig="$(printf '%s' "$signing_input" | openssl dgst -sha256 -sign "$KEY_P8" \
    | python3 -c '
import sys
der = sys.stdin.buffer.read()
i = 2 + (0 if der[1] < 0x80 else der[1] & 0x7F)
out = []
for _ in range(2):
    assert der[i] == 0x02, "unexpected DER structure"
    ln = der[i + 1]; i += 2
    out.append(int.from_bytes(der[i:i + ln], "big")); i += ln
sys.stdout.buffer.write(out[0].to_bytes(32, "big") + out[1].to_bytes(32, "big"))
' | b64url)"
  TOKEN="$signing_input.$sig"
  TOKEN_BORN="$now"
}

# --- thin API helper ---------------------------------------------------------
api() { # api METHOD PATH-or-URL [json-body-file]  -> body on stdout, HTTP code in $API_CODE
  local method="$1" url="$2" body="${3:-}" out
  case "$url" in https://*) ;; *) url="$API$url" ;; esac
  [ $(( $(date +%s) - TOKEN_BORN )) -lt 900 ] || mint_token
  out="$TMP/resp.$$"
  if [ -n "$body" ]; then
    API_CODE="$(curl -sS -o "$out" -w '%{http_code}' -X "$method" "$url" \
      -H "Authorization: Bearer $TOKEN" \
      -H 'Content-Type: application/json' --data-binary "@$body")"
  else
    API_CODE="$(curl -sS -o "$out" -w '%{http_code}' -X "$method" "$url" \
      -H "Authorization: Bearer $TOKEN")"
  fi
  cat "$out"
}

api_ok() { # like api, but any non-2xx is fatal
  local resp
  resp="$(api "$@")"
  if [ "$API_CODE" -lt 200 ] || [ "$API_CODE" -ge 300 ]; then
    { echo "ERROR: $1 $2 -> HTTP $API_CODE"; printf '%s\n' "$resp"; } >&2
    return 1
  fi
  printf '%s' "$resp"
}

jget() { # jget JSON PYEXPR — evaluate a python expression over parsed d
  python3 -c 'import json,sys; d=json.loads(sys.argv[1]); print(eval(sys.argv[2]))' "$1" "$2"
}

mint_token

# --- resolve the app ---------------------------------------------------------
APP_JSON="$(api_ok GET "/apps?filter[bundleId]=$BUNDLE_ID&fields[apps]=bundleId,name")"
APP_ID="$(jget "$APP_JSON" 'd["data"][0]["id"] if d["data"] else "" ')"
[ -n "$APP_ID" ] || { echo "ERROR: no app with bundle id $BUNDLE_ID visible to this key" >&2; exit 1; }
echo "==> app $BUNDLE_ID = $APP_ID"

if [ "$DRY_RUN" = "1" ]; then
  echo "==> beta groups on this app:"
  GROUPS_JSON="$(api_ok GET "/betaGroups?filter[app]=$APP_ID&fields[betaGroups]=name,isInternalGroup,publicLinkEnabled,publicLink")"
  jget "$GROUPS_JSON" '"\n".join(
    f"      {g[\"attributes\"][\"name\"]!r:<24} internal={g[\"attributes\"][\"isInternalGroup\"]} publicLink={g[\"attributes\"].get(\"publicLink\") or \"-\"}"
    for g in d["data"]) or "      (none)"'
  echo "==> recent builds:"
  BUILDS_JSON="$(api_ok GET "/builds?filter[app]=$APP_ID&sort=-uploadedDate&limit=5&fields[builds]=version,processingState,usesNonExemptEncryption&include=preReleaseVersion&fields[preReleaseVersions]=version")"
  jget "$BUILDS_JSON" '"\n".join(
    f"      build {b[\"attributes\"][\"version\"]:<8} processing={b[\"attributes\"][\"processingState\"]:<10} usesNonExemptEncryption={b[\"attributes\"][\"usesNonExemptEncryption\"]}"
    for b in d["data"]) or "      (none)"'
  echo "==> --dry-run: no changes made"
  exit 0
fi

# --- wait for the build to finish processing ---------------------------------
echo "==> waiting for build $MATOU_VERSION_NAME ($MATOU_VERSION_CODE) to finish processing (timeout ${TIMEOUT}s)"
DEADLINE=$(( $(date +%s) + TIMEOUT ))
BUILD_ID=""
while :; do
  BUILDS_JSON="$(api_ok GET "/builds?filter[app]=$APP_ID&filter[version]=$MATOU_VERSION_CODE&filter[preReleaseVersion.version]=$MATOU_VERSION_NAME&fields[builds]=version,processingState,usesNonExemptEncryption")"
  STATE="$(jget "$BUILDS_JSON" 'd["data"][0]["attributes"]["processingState"] if d["data"] else "ABSENT"')"
  case "$STATE" in
    VALID)
      BUILD_ID="$(jget "$BUILDS_JSON" 'd["data"][0]["id"]')"
      break ;;
    FAILED|INVALID)
      echo "ERROR: build processing ended as $STATE — see App Store Connect" >&2
      exit 1 ;;
    ABSENT|PROCESSING)
      if [ "$(date +%s)" -ge "$DEADLINE" ]; then
        echo "ERROR: build still $STATE after ${TIMEOUT}s" >&2
        exit 1
      fi
      echo "      state=$STATE, retrying in 30s"
      sleep 30 ;;
    *)
      echo "ERROR: unexpected processingState: $STATE" >&2
      exit 1 ;;
  esac
done
echo "==> build $BUILD_ID processed (VALID)"

# --- export compliance guard -------------------------------------------------
# null here means Apple is waiting for the encryption answer and the build
# would sit at "Missing Compliance" forever. The answer is baked into
# Info.plist (ITSAppUsesNonExemptEncryption + ITSEncryptionExportComplianceCode)
# so this only trips if those keys are lost.
NON_EXEMPT="$(jget "$BUILDS_JSON" 'd["data"][0]["attributes"]["usesNonExemptEncryption"]')"
if [ "$NON_EXEMPT" = "None" ]; then
  echo "ERROR: export compliance unanswered on this build — restore the ITSAppUsesNonExemptEncryption / ITSEncryptionExportComplianceCode keys in frontend/src-capacitor/ios/App/App/Info.plist" >&2
  exit 1
fi

# --- "What to Test" notes ----------------------------------------------------
if [ -z "${TESTFLIGHT_NOTES:-}" ]; then
  TESTFLIGHT_NOTES="$(git tag -l --format='%(contents:subject)' "$(git describe --tags --exact-match 2>/dev/null)" 2>/dev/null || true)"
  [ -n "$TESTFLIGHT_NOTES" ] || TESTFLIGHT_NOTES="Matou $MATOU_VERSION_NAME — see git history for changes."
fi
LOCS_JSON="$(api_ok GET "/builds/$BUILD_ID/betaBuildLocalizations?fields[betaBuildLocalizations]=locale")"
COUNT="$(jget "$LOCS_JSON" 'len(d["data"])')"
i=0
while [ "$i" -lt "$COUNT" ]; do
  LOC_ID="$(jget "$LOCS_JSON" "d[\"data\"][$i][\"id\"]")"
  python3 - "$TMP/loc.json" "$LOC_ID" "$TESTFLIGHT_NOTES" <<'PY'
import json, sys
path, loc_id, notes = sys.argv[1:4]
json.dump({"data": {"type": "betaBuildLocalizations", "id": loc_id,
                    "attributes": {"whatsNew": notes[:4000]}}}, open(path, "w"))
PY
  api_ok PATCH "/betaBuildLocalizations/$LOC_ID" "$TMP/loc.json" > /dev/null
  i=$((i + 1))
done
echo "==> what-to-test notes set on $COUNT localization(s)"

# --- Beta App Review submission ----------------------------------------------
# External groups only get builds that pass beta review. Re-running on a build
# that is already in review / approved is not an error.
python3 - "$TMP/review.json" "$BUILD_ID" <<'PY'
import json, sys
path, build_id = sys.argv[1:3]
json.dump({"data": {"type": "betaAppReviewSubmissions", "relationships":
                    {"build": {"data": {"type": "builds", "id": build_id}}}}},
          open(path, "w"))
PY
REVIEW_RESP="$(api POST "/betaAppReviewSubmissions" "$TMP/review.json")"
if [ "$API_CODE" -ge 200 ] && [ "$API_CODE" -lt 300 ]; then
  echo "==> submitted for Beta App Review"
elif printf '%s' "$REVIEW_RESP" | grep -qi "already"; then
  echo "==> already submitted for Beta App Review"
else
  { echo "ERROR: beta review submission -> HTTP $API_CODE"; printf '%s\n' "$REVIEW_RESP"; } >&2
  exit 1
fi

# --- add the build to the open group -----------------------------------------
GROUPS_JSON="$(api_ok GET "/betaGroups?filter[app]=$APP_ID&filter[name]=$(python3 -c 'import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1]))' "$GROUP_NAME")&fields[betaGroups]=name,isInternalGroup,publicLink")"
GROUP_ID="$(python3 -c '
import json, sys
d = json.loads(sys.argv[1])
print(next((g["id"] for g in d["data"] if g["attributes"]["name"] == sys.argv[2]), ""))
' "$GROUPS_JSON" "$GROUP_NAME")"
if [ -z "$GROUP_ID" ]; then
  echo "ERROR: beta group '$GROUP_NAME' not found — create it once in App Store Connect (TestFlight -> External Testing) or set TESTFLIGHT_GROUP" >&2
  exit 1
fi
python3 - "$TMP/group.json" "$BUILD_ID" <<'PY'
import json, sys
path, build_id = sys.argv[1:3]
json.dump({"data": [{"type": "builds", "id": build_id}]}, open(path, "w"))
PY
api_ok POST "/betaGroups/$GROUP_ID/relationships/builds" "$TMP/group.json" > /dev/null
PUBLIC_LINK="$(python3 -c '
import json, sys
d = json.loads(sys.argv[1])
g = next((g for g in d["data"] if g["id"] == sys.argv[2]), None)
print((g or {"attributes": {}})["attributes"].get("publicLink") or "")
' "$GROUPS_JSON" "$GROUP_ID")"
echo "==> build $MATOU_VERSION_NAME ($MATOU_VERSION_CODE) added to '$GROUP_NAME'"
[ -n "$PUBLIC_LINK" ] && echo "==> public link: $PUBLIC_LINK"
echo "==> testers get it once Beta App Review approves the build"
