# Deployment Check Script for Railway + Vercel
# Validates that all required files and configurations are in place

$ErrorActionPreference = "Stop"
$exitCode = 0

Write-Host "=== Deployment Configuration Check ===" -ForegroundColor Cyan
Write-Host ""

# Check 1: Dockerfile exists at root
Write-Host "[1/6] Checking root Dockerfile..." -ForegroundColor Yellow
if (Test-Path "Dockerfile") {
    Write-Host "  ✓ Root Dockerfile exists" -ForegroundColor Green
} else {
    Write-Host "  ✗ Root Dockerfile missing" -ForegroundColor Red
    $exitCode = 1
}

# Check 2: server/Dockerfile exists
Write-Host "[2/6] Checking server/Dockerfile..." -ForegroundColor Yellow
if (Test-Path "server/Dockerfile") {
    Write-Host "  ✓ server/Dockerfile exists" -ForegroundColor Green
} else {
    Write-Host "  ✗ server/Dockerfile missing" -ForegroundColor Red
    $exitCode = 1
}

# Check 3: railway.json exists and is valid
Write-Host "[3/6] Checking railway.json..." -ForegroundColor Yellow
if (Test-Path "railway.json") {
    try {
        $railway = Get-Content "railway.json" | ConvertFrom-Json
        if ($railway.build.dockerfilePath -eq "Dockerfile") {
            Write-Host "  ✓ railway.json has correct dockerfilePath" -ForegroundColor Green
        } else {
            Write-Host "  ✗ railway.json dockerfilePath should be 'Dockerfile'" -ForegroundColor Red
            $exitCode = 1
        }
        if ($railway.root -or $railway.build.rootDirectory) {
            Write-Host "  ⚠ railway.json has rootDirectory set (should be omitted for Pattern A)" -ForegroundColor Yellow
        }
    } catch {
        Write-Host "  ✗ railway.json is invalid JSON" -ForegroundColor Red
        $exitCode = 1
    }
} else {
    Write-Host "  ✗ railway.json missing" -ForegroundColor Red
    $exitCode = 1
}

# Check 4: server/package.json has start script
Write-Host "[4/6] Checking server/package.json start script..." -ForegroundColor Yellow
if (Test-Path "server/package.json") {
    try {
        $package = Get-Content "server/package.json" | ConvertFrom-Json
        if ($package.scripts.start) {
            Write-Host "  ✓ server/package.json has 'start' script: $($package.scripts.start)" -ForegroundColor Green
        } else {
            Write-Host "  ✗ server/package.json missing 'start' script" -ForegroundColor Red
            $exitCode = 1
        }
    } catch {
        Write-Host "  ✗ server/package.json is invalid JSON" -ForegroundColor Red
        $exitCode = 1
    }
} else {
    Write-Host "  ✗ server/package.json missing" -ForegroundColor Red
    $exitCode = 1
}

# Check 5: Health endpoint path in server code
Write-Host "[5/6] Checking /api/health endpoint..." -ForegroundColor Yellow
if (Test-Path "server/index.parent.js") {
    $healthCheck = Select-String -Path "server/index.parent.js" -Pattern "app\.get\(['""]/api/health"
    if ($healthCheck) {
        Write-Host "  ✓ /api/health endpoint found in server code" -ForegroundColor Green
    } else {
        Write-Host "  ✗ /api/health endpoint not found" -ForegroundColor Red
        $exitCode = 1
    }
} else {
    Write-Host "  ✗ server/index.parent.js missing" -ForegroundColor Red
    $exitCode = 1
}

# Check 6: Frontend API_BASE validation exists
Write-Host "[6/6] Checking frontend API_BASE validation..." -ForegroundColor Yellow
if (Test-Path "src/utils/api.ts") {
    $prodCheck = Select-String -Path "src/utils/api.ts" -Pattern "import\.meta\.env\.PROD.*VITE_API_BASE_URL"
    if ($prodCheck) {
        Write-Host "  ✓ Frontend has production validation for VITE_API_BASE_URL" -ForegroundColor Green
    } else {
        Write-Host "  ⚠ Frontend may not validate VITE_API_BASE_URL in production" -ForegroundColor Yellow
    }
} else {
    Write-Host "  ✗ src/utils/api.ts missing" -ForegroundColor Red
    $exitCode = 1
}

Write-Host ""
if ($exitCode -eq 0) {
    Write-Host "=== All checks passed! ===" -ForegroundColor Green
    Write-Host ""
    Write-Host "Next steps:" -ForegroundColor Cyan
    Write-Host "1. Set Railway environment variables:" -ForegroundColor White
    Write-Host "   - OPENAI_API_KEY" -ForegroundColor Gray
    Write-Host "   - OPENAI_MODEL (optional, defaults to gpt-5-mini)" -ForegroundColor Gray
    Write-Host ""
    Write-Host "2. Set Vercel environment variables:" -ForegroundColor White
    Write-Host "   - VITE_API_BASE_URL = https://<railway-domain>" -ForegroundColor Gray
    Write-Host ""
    Write-Host "3. Verify Railway settings:" -ForegroundColor White
    Write-Host "   - Root Directory: . (repo root)" -ForegroundColor Gray
    Write-Host "   - Dockerfile Path: Dockerfile" -ForegroundColor Gray
} else {
    Write-Host "=== Some checks failed. Please fix the issues above. ===" -ForegroundColor Red
}

exit $exitCode

