#!/usr/bin/env bash

set -euo pipefail

readonly app_url="${RISU_RUNTIME_APP_URL:-http://risuai:6001/}"

echo "[risu-runtime] Waiting for ${app_url} before starting Chromium"
until curl --fail --silent --max-time 2 --output /dev/null "${app_url}"; do
    sleep 2
done
echo "[risu-runtime] RisuAI is ready"
