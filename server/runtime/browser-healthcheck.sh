#!/usr/bin/env bash
set -u

state_file=/tmp/risu-runtime-health-failures

# Container health is process liveness, not executor claim-readiness. During a
# cold-start plugin permission the authenticated resident is intentionally not
# polling claim-next yet, but its fenced startup heartbeat proves Chromium is
# alive and lets a normal phone/PC answer the mailbox prompt.
if curl -fsS http://risuai:6001/runtime-startup/liveness >/dev/null \
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
