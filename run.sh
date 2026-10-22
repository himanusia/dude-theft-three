#!/bin/sh
# Build (TypeScript -> dist) and serve on http://localhost:8765
set -e
cd "$(dirname "$0")"
[ -d node_modules ] || npm install
npm run build
exec python3 serve.py "${1:-8765}"
