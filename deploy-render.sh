#!/usr/bin/env bash
# deploy-render.sh — Local build verification before Render deploy
# Usage:  cd ac-v6 && bash deploy-render.sh
set -euo pipefail

echo "=== Assembly Concierge v6 — Render Build Verification ==="

# 1. Clean previous build
echo "[1/5] Cleaning dist/..."
rm -rf dist/

# 2. Install dependencies
echo "[2/5] Installing dependencies..."
npm install --prefer-offline

# 3. Run tests (must all pass before build)
echo "[3/5] Running test suite..."
npm test
# Expected: Tests: 97 passed, 97 total

# 4. Compile TypeScript
echo "[4/5] Building TypeScript..."
npm run build
# Expected: no errors, dist/ directory created

# 5. Smoke-test the server (starts, responds to /health, then exits)
echo "[5/5] Smoke-testing server..."
NODE_ENV=production PORT=4001 node dist/src/server.js &
SERVER_PID=$!
sleep 3

HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:4001/health)
kill "$SERVER_PID" 2>/dev/null || true

if [ "$HTTP_STATUS" = "200" ]; then
  echo ""
  echo "PASSED: Build verification PASSED — safe to deploy to Render"
  echo "  /health returned HTTP $HTTP_STATUS"
else
  echo ""
  echo "FAILED: Build verification FAILED — /health returned HTTP $HTTP_STATUS"
  exit 1
fi
