#!/bin/sh
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 18 or newer is needed: https://nodejs.org/"
  exit 1
fi
exec node "$(dirname "$0")/tools/build.mjs" "$@"
