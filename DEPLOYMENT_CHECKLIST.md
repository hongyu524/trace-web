# Deployment Checklist: OpenAI Sequence Analysis

## Pre-Deployment Verification

### ✅ Code Verification
- [x] `api/sequence.ts` created with Responses API (`/v1/responses`)
- [x] `api/vision.ts` created (optional endpoint)
- [x] Frontend updated to call `/api/sequence` first
- [x] No OpenAI imports in `src/` (client bundle)
- [x] No `VITE_OPENAI_API_KEY` or `NEXT_PUBLIC_OPENAI_API_KEY` variables
- [x] All OpenAI calls use `process.env.OPENAI_API_KEY` only
- [x] TypeScript compilation passes (`npx tsc --noEmit`)

### ✅ API Endpoints
- [x] `/api/sequence` accepts: `{ context?, aspectRatio?, frameRate?, images: Array<{id, url?, base64?, mimeType?}> }`
- [x] `/api/sequence` returns: `{ order: number[], beats?: string[], rationale?: string }`
- [x] `/api/sequence` uses `gpt-4.1-mini` model
- [x] `/api/sequence` uses raw `fetch` to `https://api.openai.com/v1/responses`
- [x] `/api/sequence` has 45s timeout with AbortController
- [x] `/api/sequence` validates input (6-36 images, required fields)
- [x] `/api/sequence` has rate limiting (30 requests / 10 minutes)
- [x] `/api/sequence` logs OpenAI status and API key existence (boolean only)
- [x] `/api/sequence` returns 502 with `openaiStatus` and `openaiBody` on 401 errors

### ✅ Frontend Changes
- [x] `src/utils/api.ts` exports `getImageSequence()` function
- [x] `src/components/UploadFlow.tsx` calls `/api/sequence` before sending to Railway
- [x] Frontend reorders images based on sequence response
- [x] Frontend falls back to original order if sequence API fails
- [x] Progress updates show "analyzing" step before "rendering"

## Vercel Deployment

### 1. Environment Variables
- [ ] Go to Vercel Dashboard → Your Project → Settings → Environment Variables
- [ ] Add/Verify `OPENAI_API_KEY` is set to: `sk-svcacct-...` (service account key)
- [ ] Ensure `OPENAI_API_KEY` is available for **Production**, **Preview**, and **Development**
- [ ] Verify key has permission for `/v1/responses` endpoint (not `/v1/chat/completions`)

### 2. Repository Connection
- [ ] Verify Vercel project is connected to the correct GitHub repo/branch
- [ ] Check Vercel → Deployments → Latest deployment shows the correct commit (not old commits like `a7909c2`)
- [ ] If wrong repo/branch, update in Vercel → Settings → Git

### 3. Build Configuration
- [ ] Verify `vercel.json` exists and specifies Node.js runtime:
  ```json
  {
    "functions": {
      "api/**/*.ts": {
        "runtime": "nodejs20.x"
      }
    }
  }
  ```
- [ ] Build command: `npm run build` (default for Vite)
- [ ] Output directory: `dist` (default for Vite)

### 4. Deploy
- [ ] Push code to GitHub main branch:
  ```bash
  git add api/sequence.ts api/vision.ts src/utils/api.ts src/components/UploadFlow.tsx
  git commit -m "Add OpenAI sequence analysis via Vercel /api/sequence"
  git push origin main
  ```
- [ ] Wait for Vercel auto-deploy to complete
- [ ] Check Vercel → Deployments → Status is "Ready" (not "Error")

### 5. Post-Deployment Validation

#### Test `/api/sequence` endpoint:
```bash
# Test with curl (replace YOUR_VERCEL_URL with your actual Vercel domain)
curl -X POST https://YOUR_VERCEL_URL/api/sequence \
  -H "Content-Type: application/json" \
  -d '{
    "context": "A quiet weekend getaway",
    "aspectRatio": "16:9",
    "frameRate": 24,
    "images": [
      {
        "id": "0",
        "base64": "YOUR_BASE64_IMAGE_DATA",
        "mimeType": "image/jpeg"
      },
      {
        "id": "1",
        "base64": "YOUR_BASE64_IMAGE_DATA",
        "mimeType": "image/jpeg"
      }
    ]
  }'
```

Expected response:
```json
{
  "order": [0, 1, ...],
  "beats": ["opening", "build", ...],
  "rationale": "..."
}
```

#### Check logs:
- [ ] Go to Vercel → Deployments → Latest → Functions → `/api/sequence`
- [ ] Check logs show: `[SEQUENCE] OPENAI_API_KEY exists: true`
- [ ] Check logs show: `[SEQUENCE] OpenAI response status: 200` (or error details)
- [ ] Verify no errors about "Incorrect API key" or "401 Unauthorized"
- [ ] If 401 error, verify API key is correct service account key with `/v1/responses` permission

#### Test full flow:
- [ ] Upload 6-36 images in the frontend UI
- [ ] Fill in optional context/prompt
- [ ] Click "Create Memory"
- [ ] Verify progress shows "analyzing" step (sequence API call)
- [ ] Verify progress shows "rendering" step (Railway backend call)
- [ ] Verify video is created successfully

## Troubleshooting

### 401 "Incorrect API key provided"
- **Cause**: API key doesn't have permission for `/v1/responses` or is wrong key
- **Fix**: 
  1. Verify key in Vercel env vars is `sk-svcacct-...`
  2. Check OpenAI dashboard → API Keys → Key permissions include "Responses" endpoint
  3. Verify key is not restricted to `/v1/chat/completions` only

### 502 "OpenAI auth failed"
- **Cause**: API key missing or invalid
- **Fix**: 
  1. Check Vercel env vars → `OPENAI_API_KEY` is set
  2. Check logs: `[SEQUENCE] OPENAI_API_KEY exists: false` means env var not set
  3. Redeploy after adding env var

### "Rate limit exceeded"
- **Cause**: Too many requests (30 / 10 minutes per IP)
- **Fix**: Wait 10 minutes or implement Redis/Upstash rate limiting

### Sequence API fails, fallback to original order
- **Cause**: Network timeout, API error, or invalid response
- **Fix**: Check browser console and Vercel logs for error details

### Wrong repo/commit deployed
- **Cause**: Vercel connected to wrong GitHub repo or branch
- **Fix**: 
  1. Vercel → Settings → Git → Update connected repository/branch
  2. Trigger manual deploy or push new commit

## File Changes Summary

### New Files
- `api/sequence.ts` - Vercel serverless function for image sequence analysis
- `api/vision.ts` - Optional Vercel serverless function for per-image analysis
- `DEPLOYMENT_CHECKLIST.md` - This file

### Modified Files
- `src/utils/api.ts` - Added `getImageSequence()`, `SequenceResponse`, `SequenceImage` types
- `src/components/UploadFlow.tsx` - Added sequence API call before Railway backend

### No Changes
- Railway backend (`server/`) - Unchanged, still handles video rendering
- No OpenAI calls in client bundle (`src/`)

