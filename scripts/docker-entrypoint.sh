#!/bin/sh
set -eu

attempt=0

echo "Running database migrations..."

until npx prisma migrate deploy; do
  attempt=$((attempt + 1))

  if [ "$attempt" -ge 10 ]; then
    echo "Migration startup failed after retries" >&2
    exit 1
  fi

  sleep 3
done

echo "Database migrations complete"

if [ "${RUN_DB_SEED:-false}" = "true" ]; then
  echo "RUN_DB_SEED=true - running database bootstrap..."

  node dist/bootstrap-admin.js

  echo "Database bootstrap complete"
else
  echo "RUN_DB_SEED=false - skipping database bootstrap"
fi

echo "Starting Mandaria backend..."

exec node dist/main.js