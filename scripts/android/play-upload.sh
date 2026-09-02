#!/usr/bin/env bash
# Upload a signed Play App Bundle to a Google Play track (#202).
#
#   scripts/android/play-upload.sh [--dry-run] [--no-bundle] [--aab PATH]
#
# Follow-up to #176, which builds and signs the .aab in CI but left the Play
# Console upload manual. Talks to the Play Developer API v3 directly with
# bash + openssl + curl + python3 — deliberately no marketplace action and no
# Ruby/fastlane, because Forgejo actions fetched from data.forgejo.org
# fast-fail intermittently (see the checkout note in .forgejo/workflows/android.yml).
#
# Credentials (one of):
#   PLAY_SERVICE_ACCOUNT_JSON        the service-account key JSON *content*
#   PLAY_SERVICE_ACCOUNT_JSON_FILE   path to the same key on disk
# The key is written to a mktemp 0600 file and shredded on exit; nothing is
# ever written under the checkout.
#
# The service account needs "Release manager" on the app, granted in
# Play Console -> Users and permissions -> Invite new users (the old
# Setup -> API access page no longer exists). It cannot create an app's
# FIRST release — that upload must be done by hand once, which it has been.
#
# Knobs:
#   PLAY_PACKAGE_NAME        default nz.matou.app
#   PLAY_TRACK               default beta  (Play's id for the OPEN testing track;
#                            others: internal, alpha = closed, production)
#   PLAY_STATUS              default completed (live to that track's testers);
#                            draft = lands in Console for a human to release
#   PLAY_USER_FRACTION       staged rollout 0<f<1; only with status inProgress
#   PLAY_RELEASE_NOTES       release-notes text (default: derived, see below)
#   PLAY_RELEASE_NOTES_LANG  default en-GB — MUST be a language the store
#                            listing actually has, or the API rejects the patch
#   PLAY_AAB                 default frontend/dist/capacitor/android/bundle/release/app-release.aab
#
# --dry-run does everything except commit: it inserts an edit, uploads the
# bundle, patches the track, then VALIDATES and DELETES the edit. Nothing is
# published and no versionCode is consumed (uncommitted edits are discarded).
# It also prints the app's real track ids and listing languages, so the two
# settings above can be confirmed against the account rather than assumed.
#
# --no-bundle checks credentials and permissions only (insert + list + delete),
# in seconds, without needing a built .aab.
set -euo pipefail

DRY_RUN=0
NO_BUNDLE=0
AAB="${PLAY_AAB:-frontend/dist/capacitor/android/bundle/release/app-release.aab}"

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run)   DRY_RUN=1 ;;
    --no-bundle) NO_BUNDLE=1; DRY_RUN=1 ;;
    --aab)       AAB="${2:?--aab needs a path}"; shift ;;
    -h|--help)   sed -n '2,45p' "$0"; exit 0 ;;
    *) echo "ERROR: unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

PKG="${PLAY_PACKAGE_NAME:-nz.matou.app}"
TRACK="${PLAY_TRACK:-beta}"
STATUS="${PLAY_STATUS:-completed}"
NOTES_LANG="${PLAY_RELEASE_NOTES_LANG:-en-GB}"
API="https://androidpublisher.googleapis.com/androidpublisher/v3/applications/$PKG"
UPLOAD_API="https://androidpublisher.googleapis.com/upload/androidpublisher/v3/applications/$PKG"

# --- scratch space, wiped on any exit ---------------------------------------
TMP="$(mktemp -d)"
chmod 700 "$TMP"
cleanup() {
  local rc=$?
  # An edit left open would block the next run's track patch; drop it.
  if [ -n "${EDIT_ID:-}" ] && [ "${COMMITTED:-0}" = "0" ] && [ -n "${ACCESS_TOKEN:-}" ]; then
    curl -sS -o /dev/null -X DELETE "$API/edits/$EDIT_ID" \
      -H "Authorization: Bearer $ACCESS_TOKEN" || true
  fi
  rm -rf "$TMP"
  exit $rc
}
trap cleanup EXIT

# --- credentials ------------------------------------------------------------
KEY_JSON="$TMP/sa.json"
if [ -n "${PLAY_SERVICE_ACCOUNT_JSON:-}" ]; then
  ( umask 077; printf '%s' "$PLAY_SERVICE_ACCOUNT_JSON" > "$KEY_JSON" )
elif [ -n "${PLAY_SERVICE_ACCOUNT_JSON_FILE:-}" ]; then
  [ -f "$PLAY_SERVICE_ACCOUNT_JSON_FILE" ] || {
    echo "ERROR: PLAY_SERVICE_ACCOUNT_JSON_FILE=$PLAY_SERVICE_ACCOUNT_JSON_FILE not found" >&2; exit 1; }
  ( umask 077; cat "$PLAY_SERVICE_ACCOUNT_JSON_FILE" > "$KEY_JSON" )
else
  echo "ERROR: set PLAY_SERVICE_ACCOUNT_JSON or PLAY_SERVICE_ACCOUNT_JSON_FILE" >&2
  exit 1
fi

# Split the JSON once: the PEM has embedded \n that only a JSON parser undoes.
python3 - "$KEY_JSON" "$TMP" <<'PY'
import json, os, sys
key_path, tmp = sys.argv[1], sys.argv[2]
with open(key_path) as fh:
    d = json.load(fh)
for field in ("client_email", "private_key"):
    if not d.get(field):
        sys.exit(f"ERROR: service-account key is missing '{field}'")
pem = os.path.join(tmp, "sa.pem")
fd = os.open(pem, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, "w") as fh:
    fh.write(d["private_key"])
with open(os.path.join(tmp, "sa.env"), "w") as fh:
    fh.write(f"SA_EMAIL={d['client_email']}\n")
    fh.write(f"SA_TOKEN_URI={d.get('token_uri', 'https://oauth2.googleapis.com/token')}\n")
PY
# shellcheck disable=SC1091
. "$TMP/sa.env"

# --- mint a JWT and trade it for an access token -----------------------------
b64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }

NOW="$(date +%s)"
HEADER='{"alg":"RS256","typ":"JWT"}'
CLAIM="{\"iss\":\"$SA_EMAIL\",\"scope\":\"https://www.googleapis.com/auth/androidpublisher\",\"aud\":\"$SA_TOKEN_URI\",\"exp\":$((NOW + 3600)),\"iat\":$NOW}"
SIGNING_INPUT="$(printf '%s' "$HEADER" | b64url).$(printf '%s' "$CLAIM" | b64url)"
SIGNATURE="$(printf '%s' "$SIGNING_INPUT" | openssl dgst -sha256 -sign "$TMP/sa.pem" | b64url)"

curl -sS -o "$TMP/token.json" -X POST "$SA_TOKEN_URI" \
  --data-urlencode 'grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer' \
  --data-urlencode "assertion=$SIGNING_INPUT.$SIGNATURE"

ACCESS_TOKEN="$(python3 -c '
import json, sys
d = json.load(open(sys.argv[1]))
if "access_token" not in d:
    sys.exit("ERROR: token exchange failed: " + json.dumps(d))
print(d["access_token"])
' "$TMP/token.json")"
echo "==> authenticated as $SA_EMAIL"

# --- thin API helper ---------------------------------------------------------
api() { # api METHOD URL [json-body-file]
  local method="$1" url="$2" body="${3:-}" out code
  out="$TMP/resp.$$"
  if [ -n "$body" ]; then
    code="$(curl -sS -o "$out" -w '%{http_code}' -X "$method" "$url" \
      -H "Authorization: Bearer $ACCESS_TOKEN" \
      -H 'Content-Type: application/json' --data-binary "@$body")"
  else
    code="$(curl -sS -o "$out" -w '%{http_code}' -X "$method" "$url" \
      -H "Authorization: Bearer $ACCESS_TOKEN")"
  fi
  if [ "$code" -lt 200 ] || [ "$code" -ge 300 ]; then
    { echo "ERROR: $method ${url#https://androidpublisher.googleapis.com} -> HTTP $code"
      cat "$out"; echo; } >&2
    return 1
  fi
  cat "$out"
}

# --- open an edit ------------------------------------------------------------
EDIT_ID="$(api POST "$API/edits" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')"
echo "==> edit $EDIT_ID opened on $PKG"

# In a dry run, report what the account actually has so TRACK / NOTES_LANG can
# be set from evidence instead of guessed.
if [ "$DRY_RUN" = "1" ]; then
  echo "==> tracks on this app:"
  api GET "$API/edits/$EDIT_ID/tracks" | python3 -c '
import json, sys
for t in json.load(sys.stdin).get("track", []):
    codes = [c for r in t.get("releases", []) for c in r.get("versionCodes", [])]
    states = ",".join(r.get("status", "?") for r in t.get("releases", [])) or "-"
    print(f"      {t[\"track\"]:<12} versionCodes={codes or []} status={states}")'
  echo "==> store-listing languages:"
  api GET "$API/edits/$EDIT_ID/listings" | python3 -c '
import json, sys
langs = [l["language"] for l in json.load(sys.stdin).get("listings", [])]
print("      " + (", ".join(langs) if langs else "(none)"))'
fi

if [ "$NO_BUNDLE" = "1" ]; then
  echo "==> --no-bundle: credentials and permissions OK, discarding edit"
  exit 0
fi

# --- upload the bundle -------------------------------------------------------
[ -f "$AAB" ] || { echo "ERROR: bundle not found: $AAB" >&2; exit 1; }
echo "==> uploading $AAB ($(du -h "$AAB" | cut -f1))"
UPLOAD_CODE="$(curl -sS -o "$TMP/bundle.json" -w '%{http_code}' \
  -X POST "$UPLOAD_API/edits/$EDIT_ID/bundles?uploadType=media" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H 'Content-Type: application/octet-stream' \
  --data-binary "@$AAB")"
if [ "$UPLOAD_CODE" -lt 200 ] || [ "$UPLOAD_CODE" -ge 300 ]; then
  { echo "ERROR: bundle upload -> HTTP $UPLOAD_CODE"; cat "$TMP/bundle.json"; echo; } >&2
  exit 1
fi
VERSION_CODE="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["versionCode"])' "$TMP/bundle.json")"
echo "==> uploaded versionCode $VERSION_CODE"

# --- assign it to the track --------------------------------------------------
# Default notes: the annotated tag message if we are on one, else a plain line.
# There is no CHANGELOG.md in this repo to read from.
if [ -z "${PLAY_RELEASE_NOTES:-}" ]; then
  PLAY_RELEASE_NOTES="$(git tag -l --format='%(contents:subject)' "$(git describe --tags --exact-match 2>/dev/null)" 2>/dev/null || true)"
  [ -n "$PLAY_RELEASE_NOTES" ] || PLAY_RELEASE_NOTES="Matou ${MATOU_VERSION_NAME:-$VERSION_CODE} — see git history for changes."
fi

python3 - "$TMP/track.json" "$VERSION_CODE" "$STATUS" "$NOTES_LANG" "$PLAY_RELEASE_NOTES" "${PLAY_USER_FRACTION:-}" <<'PY'
import json, sys
path, code, status, lang, notes, fraction = sys.argv[1:7]
release = {
    "versionCodes": [str(code)],
    "status": status,
    "releaseNotes": [{"language": lang, "text": notes[:500]}],
}
if fraction:
    release["userFraction"] = float(fraction)
with open(path, "w") as fh:
    json.dump({"releases": [release]}, fh)
PY

api PATCH "$API/edits/$EDIT_ID/tracks/$TRACK" "$TMP/track.json" > /dev/null
echo "==> track '$TRACK' set to versionCode $VERSION_CODE (status=$STATUS)"

# --- validate or commit ------------------------------------------------------
if [ "$DRY_RUN" = "1" ]; then
  api POST "$API/edits/$EDIT_ID:validate" > /dev/null
  echo "==> DRY RUN: edit validated and discarded — nothing published"
  exit 0
fi

api POST "$API/edits/$EDIT_ID:commit?changesNotSentForReview=false" > /dev/null
COMMITTED=1
echo "==> committed: $PKG $VERSION_CODE is live on the '$TRACK' track"
