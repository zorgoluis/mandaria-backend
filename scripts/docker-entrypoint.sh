#!/bin/sh
set -eu
attempt=0
until npx prisma migrate deploy; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 10 ]; then
    echo "Migration startup failed after retries" >&2
    exit 1
  fi
  sleep 3
done
exec node dist/main.js
