#!/usr/bin/env sh
set -eu
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1 || ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) < 20 ? 1 : 0)'; then
  echo 'AgentStreet requires Node.js 20 or newer.' >&2
  exit 1
fi

if [ -d src ]; then
  if [ ! -d node_modules ]; then npm ci; fi
  npm run build
fi
exec node bin/agentstreet.js setup "$@"
