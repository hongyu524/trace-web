# Setting OpenAI API Key in Vercel

## ⚠️ Important: Never commit API keys to git!

API keys must be set as environment variables in the Vercel Dashboard or CLI.
Do NOT put real keys in this repository, including documentation.

---

## Steps to Set Your OpenAI API Key in Vercel

### Option 1: Vercel Dashboard (Recommended)

1. Go to https://vercel.com/dashboard
2. Select your project (e.g., `trace-web`)
3. Go to **Settings** → **Environment Variables**
4. Add a new environment variable:
   - **Key:** `OPENAI_API_KEY`
   - **Value:** `YOUR_OPENAI_API_KEY_HERE`
   - **Environment:** Production (optionally Preview/Development)
5. Click **Save**
6. Redeploy the latest deployment

---

### Option 2: Vercel CLI

```bash
npm i -g vercel
vercel env add OPENAI_API_KEY production
# Paste your key when prompted:
# sk-********************************
vercel --prod
```

---

## Verify

Test your endpoint to ensure the API key is working correctly.

**Note:** In PowerShell, `curl` maps to `Invoke-WebRequest`. Use `Invoke-RestMethod` or Git Bash/WSL for real `curl`.

### PowerShell (recommended): Invoke-RestMethod

```powershell
$body = @{
  photos = @(
    @{
      filename = "test.jpg"
      data     = "test"
    }
  )
} | ConvertTo-Json -Depth 5

Invoke-RestMethod `
  -Uri "https://YOUR_DOMAIN.vercel.app/api/vision" `
  -Method POST `
  -ContentType "application/json" `
  -Body $body
```

Or use the test script:

```powershell
.\scripts\test_vision.ps1 -Url "https://YOUR_DOMAIN.vercel.app/api/vision"
```

### Bash (Git Bash/WSL/macOS/Linux): curl

```bash
curl -X POST https://YOUR_DOMAIN.vercel.app/api/vision \
  -H "Content-Type: application/json" \
  -d '{"photos":[{"filename":"test.jpg","data":"test"}]}'
```

