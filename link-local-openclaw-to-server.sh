#!/usr/bin/env bash
set -euo pipefail

# Local Mac helper: verify tailnet + establish an OpenClaw server link path.
SERVER_SSH_USER_HOST="${SERVER_SSH_USER_HOST:-root@64.20.46.178}"
SERVER_SSH_PORT="${SERVER_SSH_PORT:-450}"
SERVER_TAILNET_HOST="${SERVER_TAILNET_HOST:-tappedin-server.tailnet.raywonderis.me}"
SERVER_TAILNET_IP="${SERVER_TAILNET_IP:-100.64.0.2}"
SSH_KEY_PATH="${SSH_KEY_PATH:-/Users/admin/.ssh/raywonder}"

echo "== Local Node =="
echo "Computer: $(scutil --get ComputerName 2>/dev/null || hostname)"
echo "Host:     $(hostname)"

echo
echo "== Tailnet Check =="
if command -v tailscale >/dev/null 2>&1; then
  tailscale status | sed -n '1,20p' || echo "tailscaled is not running locally."
else
  echo "tailscale CLI not found on this Mac."
fi

echo
echo "== Server Reachability =="
if command -v ping >/dev/null 2>&1; then
  ping -c 1 "${SERVER_TAILNET_IP}" >/dev/null 2>&1 && echo "Tailnet IP reachable: ${SERVER_TAILNET_IP}" || echo "Tailnet IP not reachable: ${SERVER_TAILNET_IP}"
fi

echo
echo "== SSH Link Test =="
ssh -i "${SSH_KEY_PATH}" -p "${SERVER_SSH_PORT}" \
  -o BatchMode=yes \
  -o StrictHostKeyChecking=accept-new \
  "${SERVER_SSH_USER_HOST}" \
  "echo connected_to: \$(hostname); date"

echo
echo "OpenClaw local-to-server link is active."
echo "Server tailnet host: ${SERVER_TAILNET_HOST}"
echo "Server tailnet ip:   ${SERVER_TAILNET_IP}"
