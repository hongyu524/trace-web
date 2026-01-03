/**
 * Vercel Serverless Function: Sequence Planning
 * Analyzes uploaded images and returns the best ordered sequence
 * Uses OpenAI Responses API (/v1/responses) - server-side only
 * 
 * POST /api/sequence
 * Body: {
 *   context?: string,
 *   aspectRatio?: string,
 *   frameRate?: number,
 *   images: Array<{ id: string, url?: string, base64?: string, mimeType?: string }>
 * }
 */

export const runtime = "nodejs";

// Helper function to get headers from Node-style or Fetch-style request
function getHeader(req: any, name: string): string | undefined {
  const key = name.toLowerCase();

  // Node/Vercel serverless: req.headers is an object
  if (req?.headers && typeof req.headers === "object" && typeof (req.headers as any).get !== "function") {
    const v = (req.headers as any)[key] ?? (req.headers as any)[name];
    if (Array.isArray(v)) return v[0];
    return typeof v === "string" ? v : undefined;
  }

  // Fetch/Edge style: req.headers.get exists
  if (req?.headers && typeof (req.headers as any).get === "function") {
    return (req.headers as any).get(name) ?? (req.headers as any).get(key) ?? undefined;
  }

  return undefined;
}

function setCors(req: any, res: any) {
  const origin = getHeader(req, "origin") || "";
  const allowlist = new Set([
    "https://tracememory.store",
    "https://www.tracememory.store",
    "http://localhost:5173",
    "http://localhost:3000",
  ]);

  const allowedOrigin = allowlist.has(origin) ? origin : "https://tracememory.store";

  res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

// Rate limiting: Simple in-memory store (for production, use Redis/Upstash)
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const RATE_LIMIT_MAX_REQUESTS = 30;

function getRateLimitKey(ip: string | null): string {
  return ip || 'unknown';
}

function checkRateLimit(ip: string | null): { allowed: boolean; remaining: number } {
  const key = getRateLimitKey(ip);
  const now = Date.now();
  const record = rateLimitMap.get(key);

  if (!record || now > record.resetAt) {
    rateLimitMap.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return { allowed: true, remaining: RATE_LIMIT_MAX_REQUESTS - 1 };
  }

  if (record.count >= RATE_LIMIT_MAX_REQUESTS) {
    return { allowed: false, remaining: 0 };
  }

  record.count++;
  return { allowed: true, remaining: RATE_LIMIT_MAX_REQUESTS - record.count };
}

export default async function handler(req: any, res: any) {
  setCors(req, res);
  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  // Only allow POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Rate limiting
  const clientIp = getHeader(req, 'x-forwarded-for')?.split(',')[0]?.trim() || 
                   getHeader(req, 'x-real-ip') || 
                   null;
  const rateLimit = checkRateLimit(clientIp);
  
  if (!rateLimit.allowed) {
    res.setHeader('X-RateLimit-Remaining', '0');
    res.setHeader('Retry-After', '600');
    return res.status(429).json({ 
      error: 'Rate limit exceeded', 
      message: 'Too many requests. Please try again later.' 
    });
  }

  try {
    // Input validation
    const body = req.body || (typeof req.json === 'function' ? await req.json() : {});
    
    // Support both new format (photoKeys) and legacy format (images with base64/url)
    const inputPhotoKeys = body.photoKeys;
    const photoKeys = Array.isArray(inputPhotoKeys) ? inputPhotoKeys : [];
    const legacyImages = body.images;
    
    if (!photoKeys && !legacyImages) {
      return res.status(400).json({ error: 'photoKeys array or images array required' });
    }

    const imageCount = photoKeys ? photoKeys.length : (legacyImages ? legacyImages.length : 0);
    
    if (imageCount === 0) {
      return res.status(400).json({ error: 'At least one photo key or image is required' });
    }

    // Limit number of images
    if (imageCount > 36) {
      return res.status(400).json({ error: 'Too many images (max 36)' });
    }

    if (imageCount < 6) {
      return res.status(400).json({ error: 'Too few images (min 6)' });
    }

    // Validate API key
    const apiKey = process.env.OPENAI_API_KEY;
    const hasApiKey = !!apiKey;
    console.log('[SEQUENCE] OPENAI_API_KEY exists:', hasApiKey);
    
    if (!apiKey) {
      console.error('[SEQUENCE] OPENAI_API_KEY is not set');
      return res.status(500).json({ error: 'OPENAI_API_KEY is not set' });
    }

    const context = typeof body.context === 'string' ? body.context.trim() : '';
    const aspectRatio = body.aspectRatio || '16:9';
    const frameRate = typeof body.frameRate === 'number' ? body.frameRate : 24;

    // Build image content for OpenAI
    let imageContents: Array<{ type: string; image_url: string }>;
    
    if (photoKeys) {
      // New flow: Generate presigned GET URLs for S3 keys
      console.log('[SEQUENCE] Using photoKeys mode, generating presigned GET URLs from S3');
      
      // Validate AWS credentials
      const awsRegion = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-2';
      const awsAccessKeyId = process.env.AWS_ACCESS_KEY_ID;
      const awsSecretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
      const s3Bucket = process.env.S3_BUCKET;
      
      if (!awsAccessKeyId || !awsSecretAccessKey || !s3Bucket) {
        console.error('[SEQUENCE] Missing AWS credentials for S3 access');
        return res.status(500).json({ 
          error: 'AWS credentials not configured. S3_BUCKET, AWS_ACCESS_KEY_ID, and AWS_SECRET_ACCESS_KEY must be set in Vercel environment variables.' 
        });
      }

      // Import AWS SDK (dynamic import to avoid bundling issues)
      const { S3Client, GetObjectCommand } = await import('@aws-sdk/client-s3');
      const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner');
      
      const s3 = new S3Client({
        region: awsRegion,
        credentials: {
          accessKeyId: awsAccessKeyId,
          secretAccessKey: awsSecretAccessKey,
        },
      });

      // Generate presigned GET URLs for each photo key
      const imageUrls = await Promise.all(
        photoKeys.map(async (key: string, idx: number) => {
          try {
            const signedUrl = await getSignedUrl(
              s3,
              new GetObjectCommand({
                Bucket: s3Bucket,
                Key: key,
              }),
              { expiresIn: 3600 } // 1 hour
            );
            console.log(`[SEQUENCE] Generated presigned URL for key ${idx + 1}/${photoKeys.length}: ${key}`);
            return signedUrl;
          } catch (s3Error: any) {
            console.error(`[SEQUENCE] Failed to generate presigned URL for key ${key}:`, s3Error.message);
            throw new Error(`Failed to generate presigned URL for photo ${idx + 1}: ${s3Error.message}`);
          }
        })
      );

      imageContents = imageUrls.map((url: string) => ({
        type: 'input_image',
        image_url: url
      }));
    } else {
      // Legacy flow: Support base64/url images (for backward compatibility)
      console.log('[SEQUENCE] Using legacy images mode (base64/url)');
      imageContents = legacyImages.map((img: any, idx: number) => {
        let imageUrl: string;
        if (img.url) {
          imageUrl = img.url;
        } else if (img.base64) {
          const mimeType = img.mimeType || 'image/jpeg';
          imageUrl = `data:${mimeType};base64,${img.base64}`;
        } else {
          throw new Error(`Image ${idx} (id: ${img.id}) must have either url or base64`);
        }
        
        return {
          type: 'input_image',
          image_url: imageUrl
        };
      });
    }

    // Build prompt
    const systemPrompt = `You are a professional photo editor and film story editor. Your job is to analyze a set of images and produce the best cinematic ordering for a memory video.

OUTPUT FORMAT (JSON only, no markdown):
{
  "order": [0, 1, 2, ...],  // Array of indices representing the optimal sequence
  "beats": ["opening", "build", "turn", "climax", "ending"],  // Optional: narrative beats
  "rationale": "Brief explanation of the ordering choice"
}

RULES:
- Return "order" as an array of indices [0, 1, 2, ..., n-1] where n is the number of images
- Each index must appear exactly once
- Order should create the best cinematic narrative flow
- Consider visual composition, mood transitions, and storytelling arc`;

    const userPrompt = `Context: ${context || '(none)'}
Aspect Ratio: ${aspectRatio}
Frame Rate: ${frameRate} fps

Analyze these ${imageCount} images and determine the optimal cinematic ordering.
Return ONLY valid JSON with keys: order (array of indices), beats (optional array), rationale (optional string).`;

    // Call OpenAI Responses API
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 45000); // 45s timeout
    
    try {
      const r = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "gpt-4.1-mini",
          input: [
            {
              role: "system",
              content: [{ type: "input_text", text: systemPrompt }]
            },
            {
              role: "user",
              content: [
                { type: "input_text", text: userPrompt },
                ...imageContents
              ]
            }
          ],
          max_output_tokens: 800,
        }),
        signal: controller.signal
      });

      clearTimeout(timeout);
      
      console.log('[SEQUENCE] OpenAI response status:', r.status);
      
      const json = await r.json();
      
      if (!r.ok) {
        console.error('[SEQUENCE] OpenAI API error:', r.status, JSON.stringify(json).substring(0, 200));
        return res.status(502).json({ 
          error: "OpenAI auth failed", 
          openaiStatus: r.status, 
          openaiBody: json 
        });
      }

      // Ensure text is a string
      // Extract text safely - treat OpenAI output as plain text, not JSON
      const rawText =
        typeof json.output_text === "string"
          ? json.output_text
          : Array.isArray(json.output)
            ? json.output.map((o: any) => o?.content?.map((c: any) => c?.text).join("")).join("")
            : String(json);
      
      console.log("[SEQUENCE] text type:", typeof rawText);

      // Ensure sequence array is always present for backward compatibility
      const sequence = Array.isArray(photoKeys)
        ? photoKeys.map((key, i) => ({ key, order: i + 1 }))
        : [];

      // Extract order as number array for backward compatibility (frontend expects order: number[])
      const order = Array.isArray(photoKeys)
        ? photoKeys.map((_, i) => i)
        : [];

      // Return response with narrative text
      res.setHeader('X-RateLimit-Remaining', rateLimit.remaining.toString());
      return res.status(200).json({
        ok: true,
        sequence,        // ALWAYS present, ALWAYS array
        order,           // ALWAYS present, ALWAYS array (for backward compatibility)
        photoKeys,       // keep
        narrative: rawText || "",
      });

    } catch (error: any) {
      clearTimeout(timeout);
      
      if (error.name === 'AbortError') {
        console.error('[SEQUENCE] Request timed out');
        return res.status(504).json({ error: 'Request timed out' });
      }
      
      console.error('[SEQUENCE] Error calling OpenAI:', error);
      throw error;
    }

  } catch (error: any) {
    console.error('[SEQUENCE] Error:', error);
    return res.status(500).json({ 
      error: "sequence_failed",
      detail: String(error?.message || error || 'Unknown error')
    });
  }
}

