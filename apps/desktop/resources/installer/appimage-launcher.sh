#!/bin/sh
# An AppImage mounts nosuid, so user namespaces are Chromium's only sandbox here.
set -eu

app="$(dirname "$(readlink -f "$0")")/UsageAtlas"

if command -v unshare >/dev/null 2>&1; then
  unshare --user --map-root-user true >/dev/null 2>&1 || set -- --no-sandbox "$@"
elif [ "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null || echo 0)" = 1 ]; then
  set -- --no-sandbox "$@"
fi

exec "$app" "$@"
