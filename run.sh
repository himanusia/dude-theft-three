#!/bin/sh
# Start the game: http://localhost:8765/
cd "$(dirname "$0")" || exit 1
python3 serve.py "${1:-8765}"
