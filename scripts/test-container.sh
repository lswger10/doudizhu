#!/usr/bin/env bash
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
fixture=$(mktemp -d)
trap 'rm -rf -- "$fixture"' EXIT
export TEST_EVENTS="$fixture/events"
export TEST_MODE=standalone
export PATH="$fixture:$PATH"
cat > "$fixture/node" <<'FAKE'
#!/usr/bin/env bash
[[ -z ${CONTROL_PLANE_API_KEY:-} ]] || exit 91
echo game-start >> "$TEST_EVENTS"
[[ $TEST_MODE != standalone ]] || exit 0
trap 'echo game-stop >> "$TEST_EVENTS"; exit 0' TERM
while true; do sleep 0.05; done
FAKE
cat > "$fixture/tunnel-client" <<'FAKE'
#!/usr/bin/env bash
[[ -z ${DOUDIZHU_SERVICE_KEY:-} ]] || exit 92
if [[ $1 == init ]]; then
  [[ -z ${CONTROL_PLANE_API_KEY:-} ]] || exit 93
  exit 0
fi
[[ ${CONTROL_PLANE_API_KEY:-} == synthetic-test-key ]] || exit 94
echo tunnel-start >> "$TEST_EVENTS"
sleep 0.2
exit 17
FAKE
chmod +x "$fixture/node" "$fixture/tunnel-client"
unset DOUDIZHU_TUNNEL_ID CONTROL_PLANE_API_KEY
bash "$root/scripts/start-container.sh"
export DOUDIZHU_TUNNEL_ID=tunnel_test
if bash "$root/scripts/start-container.sh" 2>/dev/null; then
  echo 'Missing tunnel key was accepted' >&2; exit 1
fi
export CONTROL_PLANE_API_KEY=synthetic-test-key DOUDIZHU_SERVICE_KEY=synthetic-game-key TEST_MODE=tunnel
set +e
bash "$root/scripts/start-container.sh"
status=$?
set -e
[[ $status == 17 ]]
grep -q '^tunnel-start$' "$TEST_EVENTS"
grep -q '^game-stop$' "$TEST_EVENTS"
echo 'Container lifecycle and credential isolation passed'
