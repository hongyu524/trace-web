#!/bin/bash
# Deployment Check Script for Railway + Vercel
# Validates that all required files and configurations are in place

set -e

EXIT_CODE=0

echo "=== Deployment Configuration Check ==="
echo ""

# Check 1: Dockerfile exists at root
echo "[1/6] Checking root Dockerfile..."
if [ -f "Dockerfile" ]; then
    echo "  ✓ Root Dockerfile exists"
else
    echo "  ✗ Root Dockerfile missing"
    EXIT_CODE=1
fi

# Check 2: server/Dockerfile exists
echo "[2/6] Checking server/Dockerfile..."
if [ -f "server/Dockerfile" ]; then
    echo "  ✓ server/Dockerfile exists"
else
    echo "  ✗ server/Dockerfile missing"
    EXIT_CODE=1
fi

# Check 3: railway.json exists and is valid
echo "[3/6] Checking railway.json..."
if [ -f "railway.json" ]; then
    if command -v jq &> /dev/null; then
        DOCKERFILE_PATH=$(jq -r '.build.dockerfilePath // empty' railway.json)
        if [ "$DOCKERFILE_PATH" = "Dockerfile" ]; then
            echo "  ✓ railway.json has correct dockerfilePath"
        else
            echo "  ✗ railway.json dockerfilePath should be 'Dockerfile'"
            EXIT_CODE=1
        fi
        ROOT_DIR=$(jq -r '.root // .build.rootDirectory // empty' railway.json)
        if [ -n "$ROOT_DIR" ]; then
            echo "  ⚠ railway.json has rootDirectory set (should be omitted for Pattern A)"
        fi
    else
        echo "  ⚠ jq not installed, skipping JSON validation (install with: brew install jq / apt-get install jq)"
        if grep -q "dockerfilePath.*Dockerfile" railway.json; then
            echo "  ✓ dockerfilePath appears correct (approximate check)"
        fi
    fi
else
    echo "  ✗ railway.json missing"
    EXIT_CODE=1
fi

# Check 4: server/package.json has start script
echo "[4/6] Checking server/package.json start script..."
if [ -f "server/package.json" ]; then
    if command -v jq &> /dev/null; then
        START_SCRIPT=$(jq -r '.scripts.start // empty' server/package.json)
        if [ -n "$START_SCRIPT" ]; then
            echo "  ✓ server/package.json has 'start' script: $START_SCRIPT"
        else
            echo "  ✗ server/package.json missing 'start' script"
            EXIT_CODE=1
        fi
    else
        if grep -q '"start"' server/package.json; then
            echo "  ✓ server/package.json appears to have 'start' script (approximate check)"
        else
            echo "  ✗ server/package.json missing 'start' script"
            EXIT_CODE=1
        fi
    fi
else
    echo "  ✗ server/package.json missing"
    EXIT_CODE=1
fi

# Check 5: Health endpoint path in server code
echo "[5/6] Checking /api/health endpoint..."
if [ -f "server/index.parent.js" ]; then
    if grep -q "app\.get.*['\"]/api/health" server/index.parent.js; then
        echo "  ✓ /api/health endpoint found in server code"
    else
        echo "  ✗ /api/health endpoint not found"
        EXIT_CODE=1
    fi
else
    echo "  ✗ server/index.parent.js missing"
    EXIT_CODE=1
fi

# Check 6: Frontend API_BASE validation exists
echo "[6/6] Checking frontend API_BASE validation..."
if [ -f "src/utils/api.ts" ]; then
    if grep -q "import\.meta\.env\.PROD.*VITE_API_BASE_URL" src/utils/api.ts; then
        echo "  ✓ Frontend has production validation for VITE_API_BASE_URL"
    else
        echo "  ⚠ Frontend may not validate VITE_API_BASE_URL in production"
    fi
else
    echo "  ✗ src/utils/api.ts missing"
    EXIT_CODE=1
fi

echo ""
if [ $EXIT_CODE -eq 0 ]; then
    echo "=== All checks passed! ==="
    echo ""
    echo "Next steps:"
    echo "1. Set Railway environment variables:"
    echo "   - OPENAI_API_KEY"
    echo "   - OPENAI_MODEL (optional, defaults to gpt-5-mini)"
    echo ""
    echo "2. Set Vercel environment variables:"
    echo "   - VITE_API_BASE_URL = https://<railway-domain>"
    echo ""
    echo "3. Verify Railway settings:"
    echo "   - Root Directory: . (repo root)"
    echo "   - Dockerfile Path: Dockerfile"
else
    echo "=== Some checks failed. Please fix the issues above. ==="
fi

exit $EXIT_CODE



