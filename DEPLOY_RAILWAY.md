# Railway Deployment Guide

## Pattern A: Root Dockerfile (Current Configuration)

This project uses **Pattern A**: Railway builds from repository root with a root-level Dockerfile.

### Railway UI Settings

**Service:** trace-web (or your Railway service name)

**Settings → Build:**

- **Source:** GitHub repository `hongyu524/trace-web` (or your repo)
- **Branch:** `main`
- **Root Directory:** `(blank / default)` - Leave empty or set to `.` (repo root)
- **Dockerfile Path:** `Dockerfile` (relative to root directory)
- **Start Command:** `(blank)` - Leave empty (uses Dockerfile CMD: `npm start`)

**Important:** Do NOT set Root Directory to `server/`. This will cause build failures because Railway will look for `server/server/...` paths.

### Environment Variables (Railway)

Set in Railway → Service → Variables:

```
OPENAI_API_KEY = sk-... (required)
OPENAI_MODEL = gpt-5-mini (optional, defaults to gpt-5-mini if not set)
```

**Do NOT set:**
- `VITE_API_BASE_URL` (frontend-only, belongs in Vercel)
- Any other `VITE_*` variables (frontend-only)

### Architecture

```
Repository Root (.)
├── Dockerfile          ← Railway uses this (Pattern A)
├── railway.json        ← Config: dockerfilePath = "Dockerfile"
├── server/             ← Backend code
│   ├── index.js
│   ├── package.json
│   └── Dockerfile      ← NOT USED (kept for reference only)
└── src/                ← Frontend code (deployed to Vercel)
```

### Build Process

1. Railway clones repository root
2. Railway uses root `Dockerfile` with build context = repo root
3. Dockerfile copies `server/package*.json` and `server/` contents
4. Container runs `npm start` (from `server/package.json`)
5. Server listens on `process.env.PORT` (defaults to 8080)

### Verification

After deployment, verify:

1. **Health endpoint:**
   ```bash
   curl https://your-service.railway.app/api/health
   # Should return: {"ok": true, ...}
   ```

2. **Server logs:**
   - Railway → Deployments → Logs
   - Should see: `[SERVER] Server started on port 8080` (or Railway-assigned PORT)

3. **Build success:**
   - Railway → Deployments → Should show "Build succeeded"
   - No errors about `/server: not found` or `COPY server/...` failures

### Troubleshooting

**Error: "directory /server does not exist"**
- ✅ Fix: Ensure Root Directory is blank/default (repo root)
- ❌ Wrong: Root Directory = `server/`

**Error: "COPY server/package*.json: file not found"**
- ✅ Fix: Ensure Root Directory is repo root (not `server/`)
- ✅ Verify: `server/package.json` exists in repository

**Error: "Failed to build an image"**
- Check: Railway → Settings → Dockerfile Path = `Dockerfile` (not `server/Dockerfile`)
- Check: Root Directory is blank/default (repo root)

### Frontend Deployment (Vercel)

The frontend is deployed separately to Vercel:

**Vercel Environment Variables:**
```
VITE_API_BASE_URL = https://your-railway-service.railway.app
```

**Do NOT set in Vercel:**
- `OPENAI_API_KEY` (backend-only)
- `OPENAI_MODEL` (backend-only)

### Related Files

- `Dockerfile` (root) - Used by Railway
- `railway.json` - Railway configuration
- `server/Dockerfile` - NOT USED (reference only)
- `server/package.json` - Backend dependencies and start script
- `server/index.js` - Backend entry point



