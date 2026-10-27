#!/bin/sh
set -eu

DISPLAY_NUM="${GATEWAY_DISPLAY_NUM:-99}"
export DISPLAY=":${DISPLAY_NUM}"
LOG_FILE="/tmp/codex-web-gateway-xvfb.log"

Xvfb "$DISPLAY" -screen 0 1365x900x24 -nolisten tcp -ac >"$LOG_FILE" 2>&1 &
XVFB_PID=$!
VNC_PID=""

cleanup() {
  if [ -n "$VNC_PID" ]; then
    kill "$VNC_PID" 2>/dev/null || true
    wait "$VNC_PID" 2>/dev/null || true
  fi
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
x11vnc -display "$DISPLAY" -rfbport 5900 -localhost -nopw -forever -shared -noxdamage -repeat -quiet >/tmp/codex-web-gateway-vnc.log 2>&1 &
VNC_PID=$!
sleep 0.3
if ! kill -0 "$VNC_PID" 2>/dev/null; then
  echo "[gateway-container] x11vnc failed to start" >&2
  cat /tmp/codex-web-gateway-vnc.log >&2 || true
  exit 1
fi
echo "[gateway-container] VNC server is listening on localhost:5900"
bun run src/cli.ts gateway
STATUS=$?
exit "$STATUS"
