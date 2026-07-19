#!/usr/bin/env bash
set -euo pipefail

# Load the host-owned agent-control environment without copying secrets into
# PM2 configuration, logs, or the repository.
environment_file="${OPENLINK_ENV_FILE:-/etc/openlink/agent-control.env}"
if [[ -r "$environment_file" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$environment_file"
  set +a
fi

export NODE_ENV="${NODE_ENV:-production}"
cd /home/dom/apps/openlink-signaling
exec /usr/bin/node signaling-server.js 8767
