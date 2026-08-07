#!/usr/bin/env bash

set -euo pipefail

readonly readiness_url="${RISU_RUNTIME_READINESS_URL:-http://risuai:6001/logo_32.png}"

echo "[risu-runtime] Waiting for ${readiness_url} before starting Chromium"
until curl --fail --silent --max-time 2 --output /dev/null "${readiness_url}"; do
    sleep 2
done
echo "[risu-runtime] RisuAI is ready"
