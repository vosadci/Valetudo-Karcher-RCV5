#!/bin/bash
#
# Builds everything the RCV5 binary serves: Valetudo's own web UI, the Kärcher UI
# (contrib/karcher-rcv5/webui, served at /karcher-ui/), then the armv7 binary that embeds both.
# The order matters — the frontend build wipes frontend/build, and pkg embeds whatever is in it.
#
# Usage: contrib/karcher-rcv5/build.sh   (from anywhere; output: build/armv7/valetudo)
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

echo "== 1/3 Valetudo web UI =="
npm run build --workspace=frontend

echo "== 2/3 Kärcher web UI (/karcher-ui/) =="
node contrib/karcher-rcv5/webui/build.js

if [ ! -f frontend/build/karcher-ui/index.html ] || [ ! -f frontend/build/index.html ]; then
    echo "ERROR: frontend/build is missing index.html or karcher-ui/index.html — refusing to package an incomplete UI" >&2
    exit 1
fi

echo "== 3/3 armv7 binary =="
npm run build_armv7 --workspace=backend

ls -la build/armv7/valetudo
