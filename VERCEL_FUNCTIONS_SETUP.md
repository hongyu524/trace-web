# Vercel Serverless Functions Setup

## ✅ Implementation Complete

Two Vercel serverless functions have been created to handle OpenAI API calls:

1. **`api/vision.ts`** - Vision analysis endpoint
2. **`api/sequence.ts`** - Sequence planning endpoint

---

## 📁 Files Created

### `api/vision.ts`
- **Endpoint:** `POST /api/vision`
- **Purpose:** Analyzes images using OpenAI Vision API
- **Input:** `{ photos: Array<{filename: string, data: string (base64), mimeType?: string}> }`
- **Output:** `{ ok: true, results: Array<analysis>, count: number }`
- **Features:**
  - Rate limiting: 30 requests per 10 minutes per IP
  - Input validation: validates photos array, base64 data, file sizes
  - Batch size cap: Maximum 36 photos per request
  - Error handling with safe fallbacks
  - Sequential processing to avoid OpenAI rate limits

### `api/sequence.ts`
- **Endpoint:** `POST /api/sequence`
- **Purpose:** Creates narrative sequence plan from vision analysis results
- **Input:** `{ analysisResults: Array, promptText?: string }`
- **Output:** `{ ok: true, plan: {...} }`
- **Features:**
  - Rate limiting: 30 requests per 10 minutes per IP
  - Input validation: validates analysisResults array
  - Batch size cap: Maximum 200 images per request
  - Deterministic fallback on errors
  - 30-second timeout protection

---

## 🔒 Security Features

### Rate Limiting
- **Current:** In-memory rate limiting (30 requests / 10 minutes per IP)
- **Production Recommendation:** Migrate to Upstash Redis for distributed rate limiting
- **Headers:** `X-RateLimit-Remaining`, `Retry-After` on 429 responses

### Input Validation
- ✅ Method validation (POST only)
- ✅ Request body structure validation
- ✅ Array length limits (36 photos, 200 images)
- ✅ Base64 data size limits (~10MB per image)
- ✅ Required field validation

### Environment Variables
- ✅ Uses `process.env.OPENAI_API_KEY` (server-side only)
- ✅ No `VITE_*` or `NEXT_PUBLIC_*` prefixes (client-safe)
- ✅ API key validation before processing

---

## 📦 Dependencies

### Added to `package.json`:
```json
"openai": "^6.15.0"
```

This dependency is only used by Vercel serverless functions, not bundled with the frontend.

---

## ⚙️ Configuration

### `vercel.json`
```json
{
  "functions": {
    "api/**/*.ts": {
      "runtime": "nodejs20.x"
    }
  }
}
```

---

## 🚀 Deployment Steps

1. **Set Environment Variables in Vercel:**
   - Go to Vercel Dashboard → Project Settings → Environment Variables
   - Add: `OPENAI_API_KEY` = `sk-...` (your service account key)
   - Optional: `OPENAI_MODEL` = `gpt-4o` or `gpt-4o-mini` (defaults provided)

2. **Deploy to Vercel:**
   - Push code to GitHub
   - Vercel will auto-detect and deploy the functions
   - Functions will be available at:
     - `https://your-domain.vercel.app/api/vision`
     - `https://your-domain.vercel.app/api/sequence`

3. **Update Frontend/Railway to Call Vercel:**
   - Replace OpenAI calls with HTTP requests to Vercel endpoints
   - Frontend should call Vercel directly (recommended)
   - Or Railway can call Vercel server-to-server

---

## 🔄 Next Steps

### Immediate:
1. ✅ Set `OPENAI_API_KEY` in Vercel environment variables
2. ✅ Deploy to Vercel
3. ✅ Test endpoints with sample requests

### Update Railway Backend:
Replace the error throws in `server/index.parent.js` with calls to Vercel:

```typescript
// Instead of throwing error, call Vercel endpoint
const vercelApiBase = process.env.VERCEL_API_BASE_URL || 'https://your-app.vercel.app';
const visionResponse = await fetch(`${vercelApiBase}/api/vision`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ photos: ... })
});
```

### Optional Enhancements:
1. **Upgrade Rate Limiting:** Migrate to Upstash Redis for production
2. **Add Monitoring:** Add logging/monitoring for function invocations
3. **Add Caching:** Cache vision analysis results for duplicate images
4. **Add Request ID:** Add correlation IDs for debugging

---

## 📝 API Usage Examples

### Vision Analysis Request:
```typescript
const response = await fetch('https://your-app.vercel.app/api/vision', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    photos: [
      {
        filename: 'photo1.jpg',
        data: 'base64encodedimagedata...', // base64 string
        mimeType: 'image/jpeg' // optional
      }
    ]
  })
});

const { ok, results, count } = await response.json();
```

### Sequence Planning Request:
```typescript
const response = await fetch('https://your-app.vercel.app/api/sequence', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    analysisResults: [
      { id: '0', filename: 'photo1.jpg', subject: 'landscape', ... },
      { id: '1', filename: 'photo2.jpg', subject: 'person', ... }
    ],
    promptText: 'A quiet weekend getaway'
  })
});

const { ok, plan } = await response.json();
```

---

## ✅ Verification Checklist

- [x] Functions created in `api/` directory
- [x] OpenAI package added to dependencies
- [x] Rate limiting implemented
- [x] Input validation implemented
- [x] Error handling implemented
- [x] `vercel.json` configuration added
- [ ] `OPENAI_API_KEY` set in Vercel (TODO: after deployment)
- [ ] Frontend/Railway updated to call Vercel endpoints (TODO)

---

## 🔍 Code Quality

- ✅ TypeScript with proper types
- ✅ No linter errors
- ✅ Follows existing code patterns
- ✅ Proper error handling
- ✅ Security best practices
- ✅ Production-ready rate limiting foundation

---

**Status:** ✅ Ready for deployment

