#!/bin/sh
set -eu

DISPLAY_NUM="${GATEWAY_DISPLAY_NUM:-99}"
export DISPLAY=":${DISPLAY_NUM}"
LOG_FILE="/tmp/codex-web-gateway-xvfb.log"

Xvfb "$DISPLAY" -screen 0 1365x900x24 -nolisten tcp -ac >"$LOG_FILE" 2>&1 &
XVFB_PID=$!

cleanup() {
  kill "$XVFB_PID" 2>/dev/null || true
  wait "$XVFB_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

i=0
while ! xdpyinfo -display "$DISPLAY" >/dev/null 2>&1; do
  if ! kill -0 "$XVFB_PID" 2>/dev/null; then
    echo "[gateway-container] Xvfb exited before the display became ready" >&2
    cat "$LOG_FILE" >&2 || true
    exit 1
  fi
  i=$((i + 1))
  if [ "$i" -ge 100 ]; then
    echo "[gateway-container] timed out waiting for X display $DISPLAY" >&2
    cat "$LOG_FILE" >&2 || true
    exit 1
  fi
  sleep 0.1
done

echo "[gateway-container] X display $DISPLAY is ready"
bun run src/cli.ts gateway
STATUS=$?
exit "$STATUS"
