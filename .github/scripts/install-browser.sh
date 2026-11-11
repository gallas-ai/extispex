#!/usr/bin/env bash
# Installs Chromium and the system packages the browser tests need. A runner sometimes cannot reach
# the Ubuntu package mirror for a while, so a failed attempt is retried after a pause instead of
# failing the run. Each failed attempt already takes minutes, because apt waits on every package.
set -euo pipefail

attempts="${INSTALL_BROWSER_ATTEMPTS:-3}"
pause_seconds="${INSTALL_BROWSER_PAUSE_SECONDS:-60}"

for attempt in $(seq 1 "$attempts"); do
  if deno task install:browser --with-deps; then
    exit 0
  fi
  echo "::warning::Installing Chromium failed, attempt ${attempt} of ${attempts}."
  if [ "$attempt" -lt "$attempts" ]; then
    sleep $((attempt * pause_seconds))
  fi
done
echo "::error::Installing Chromium failed ${attempts} times."
exit 1
