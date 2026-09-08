#!/bin/sh
# A single-file Docker bind mount can retain an old inode after host-side atomic replacement.
# Pass the canonical host configuration over stdin for both validation and hot reload.
set -eu
if [ "$#" -ne 2 ]; then
  echo 'Usage: reload-inference-proxy.sh CONTAINER HOST_CADDYFILE' >&2
  exit 2
fi
reload_container=$1
reload_config=$2
umask 077
reload_snapshot=$(mktemp)
trap 'rm -f "$reload_snapshot"' EXIT HUP INT TERM
cat "$reload_config" > "$reload_snapshot"
docker exec -i "$reload_container" caddy validate --config - --adapter caddyfile < "$reload_snapshot"
docker exec -i "$reload_container" caddy reload --config - --adapter caddyfile < "$reload_snapshot"
