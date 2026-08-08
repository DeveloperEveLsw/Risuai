#!/usr/bin/env bash
set -u

state_file=/tmp/risu-runtime-health-failures

if curl -fsS http://risuai:6001/runtime-generations/executor/health >/dev/null \
    && curl -fsS http://127.0.0.1:9222/json | grep -q 'risu-runtime=executor'
then
    rm -f "$state_file"
    exit 0
fi

failures=0
if [[ -f "$state_file" ]]; then
    read -r failures < "$state_file" || failures=0
fi
if ! [[ "$failures" =~ ^[0-9]+$ ]]; then
    failures=0
fi
failures=$((failures + 1))
printf '%s\n' "$failures" > "$state_file"

if (( failures >= 3 )); then
    # Docker marks unhealthy containers but does not restart them. Terminate
    # the browser after three failed executor probes; linuxserver's app
    # supervisor (RESTART_APP=true) starts it again with the persistent profile.
    rm -f "$state_file"
    pkill -TERM -x chromium 2>/dev/null || true
fi

exit 1
