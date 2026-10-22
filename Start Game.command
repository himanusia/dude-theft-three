#!/bin/sh
cd "$(dirname "$0")" || exit 1
open "http://localhost:8765/" 2>/dev/null
exec python3 serve.py 8765
