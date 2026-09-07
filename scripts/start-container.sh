#!/usr/bin/env bash
set -euo pipefail

# No tunnel configuration keeps the existing standalone deployment behavior.
if [[ -z ${DOUDIZHU_TUNNEL_ID:-} && -z ${CONTROL_PLANE_API_KEY:-} ]]; then
  exec node src/server.js
fi
: "${DOUDIZHU_TUNNEL_ID:?Set the tunnel ID}"
: "${CONTROL_PLANE_API_KEY:?Set the tunnel runtime key}"
export DOUDIZHU_MCP_PORT=8899
profile_dir=$(mktemp -d)
game_pid=''
tunnel_pid=''
cleanup() {
  trap - EXIT TERM INT
  [[ -z $tunnel_pid ]] || kill -TERM "$tunnel_pid" 2>/dev/null || true
  [[ -z $game_pid ]] || kill -TERM "$game_pid" 2>/dev/null || true
  wait || true
  rm -rf -- "$profile_dir"
}
trap cleanup EXIT
trap 'exit 143' TERM
trap 'exit 130' INT

# The generated profile contains only a secret reference, never the key.
env -u CONTROL_PLANE_API_KEY -u DOUDIZHU_SERVICE_KEY tunnel-client init \
  --profile ddz-seat --profile-dir "$profile_dir" \
  --tunnel-id "$DOUDIZHU_TUNNEL_ID" \
  --mcp-server-url http://127.0.0.1:8899/mcp \
  --health-listen-addr 127.0.0.1:8897
(unset CONTROL_PLANE_API_KEY; exec node src/server.js) &
game_pid=$!
(unset DOUDIZHU_SERVICE_KEY; exec tunnel-client run --profile ddz-seat --profile-dir "$profile_dir") &
tunnel_pid=$!
# A failed child ends this container; the platform owns restart policy.
set +e
wait -n "$game_pid" "$tunnel_pid"
status=$?
[[ $status -ne 0 ]] || status=1
exit "$status"
