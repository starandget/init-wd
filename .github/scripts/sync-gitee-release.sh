#!/usr/bin/env bash
set -euo pipefail

# Required env:
#   GITEE_TOKEN, GITEE_USERNAME, GITEE_REPO, RELEASE_TAG, RELEASE_DIR
# Optional env:
#   RELEASE_NAME, RELEASE_BODY

if [[ -z "${GITEE_TOKEN:-}" ]]; then
  echo "GITEE_TOKEN is not set, skipping Gitee Release sync."
  exit 0
fi

OWNER="${GITEE_USERNAME:-starandget}"
REPO="${GITEE_REPO:-star-box}"
TAG="${RELEASE_TAG:?RELEASE_TAG is required}"
NAME="${RELEASE_NAME:-$TAG}"
if [[ -z "$NAME" ]]; then
  NAME="$TAG"
fi
BODY="${RELEASE_BODY:-}"
if [[ -z "$BODY" ]]; then
  BODY="Release ${TAG}"
fi
DIR="${RELEASE_DIR:?RELEASE_DIR is required}"

API_BASE="https://gitee.com/api/v5/repos/${OWNER}/${REPO}"

echo "Syncing Gitee Release for ${OWNER}/${REPO} tag=${TAG}..."

# 1. Check if release already exists for this tag
# Note: Gitee may return HTTP 200 with JSON `null` or `{}` when no release exists.
RESP_FILE=$(mktemp)
HTTP_CODE=$(curl -sS -o "$RESP_FILE" -w "%{http_code}" \
  "${API_BASE}/releases/tags/${TAG}?access_token=${GITEE_TOKEN}")

RELEASE_ID=""
if [[ "$HTTP_CODE" == "200" ]]; then
  RELEASE_ID=$(jq -r 'if type == "object" then (.id // empty) else empty end' "$RESP_FILE" 2>/dev/null || true)
fi

if [[ -n "$RELEASE_ID" ]]; then
  echo "Found existing Gitee Release id=${RELEASE_ID}"
else
  echo "Creating Gitee Release for tag=${TAG}..."
  CREATE_CODE=$(curl -sS -o "$RESP_FILE" -w "%{http_code}" \
    -X POST "${API_BASE}/releases" \
    -F "access_token=${GITEE_TOKEN}" \
    -F "tag_name=${TAG}" \
    -F "name=${NAME}" \
    -F "body=${BODY}" \
    -F "target_commitish=${TAG}")
  if [[ "$CREATE_CODE" != "201" && "$CREATE_CODE" != "200" ]]; then
    echo "Failed to create Gitee Release (HTTP ${CREATE_CODE}):" >&2
    cat "$RESP_FILE" >&2
    exit 1
  fi
  RELEASE_ID=$(jq -r 'if type == "object" then (.id // empty) else empty end' "$RESP_FILE" 2>/dev/null || true)
  if [[ -z "$RELEASE_ID" ]]; then
    echo "Gitee Release creation returned no id:" >&2
    cat "$RESP_FILE" >&2
    exit 1
  fi
  echo "Created Gitee Release id=${RELEASE_ID}"
fi

# 2. Fetch existing attached files so we can replace duplicates cleanly
ATTACH_FILE=$(mktemp)
curl -sS -o "$ATTACH_FILE" \
  "${API_BASE}/releases/${RELEASE_ID}/attach_files?access_token=${GITEE_TOKEN}" || echo "[]" > "$ATTACH_FILE"

shopt -s nullglob
DMGS=("${DIR}"/*.dmg)
if [[ ${#DMGS[@]} -eq 0 ]]; then
  echo "No .dmg files found in ${DIR}, nothing to upload."
  exit 0
fi

for dmg in "${DMGS[@]}"; do
  fname=$(basename "$dmg")

  # Delete existing file with the same name if present
  existing_ids=$(jq -r --arg name "$fname" '.[]? | select(.name == $name) | .id' "$ATTACH_FILE" || true)
  for aid in $existing_ids; do
    echo "Removing old Gitee attachment ${fname} (id=${aid})..."
    curl -sS -o /dev/null -X DELETE \
      "${API_BASE}/releases/${RELEASE_ID}/attach_files/${aid}?access_token=${GITEE_TOKEN}" || true
  done

  echo "Uploading ${fname} to Gitee Release id=${RELEASE_ID}..."
  UP_CODE=$(curl -sS -o "$RESP_FILE" -w "%{http_code}" \
    -X POST "${API_BASE}/releases/${RELEASE_ID}/attach_files" \
    -F "access_token=${GITEE_TOKEN}" \
    -F "file=@${dmg}")
  if [[ "$UP_CODE" != "201" && "$UP_CODE" != "200" ]]; then
    echo "Failed to upload ${fname} (HTTP ${UP_CODE}):" >&2
    cat "$RESP_FILE" >&2
    exit 1
  fi
  echo "Uploaded ${fname} successfully."
done

rm -f "$RESP_FILE" "$ATTACH_FILE"
