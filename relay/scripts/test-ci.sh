#!/usr/bin/env bash
# Lance un relais local avec des limites basses, exécute les tests d'intégration, puis l'arrête.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f .dev.vars ] || node scripts/vapid.mjs --dev-vars > .dev.vars
npm run dev:test > /tmp/relay-test.log 2>&1 &
PID=$!
trap 'kill $PID 2>/dev/null || true; pkill -f "workerd serve" 2>/dev/null || true' EXIT
for _ in $(seq 1 60); do curl -sf http://127.0.0.1:8787/ > /dev/null && break; sleep 1; done
curl -sf http://127.0.0.1:8787/ > /dev/null || { cat /tmp/relay-test.log; exit 1; }
node --test test/*.test.mjs
