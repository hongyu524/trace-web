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

export default async function handler(req: Request): Promise<Response> {
  // Only allow POST
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  // Rate limiting
  const clientIp = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 
                   req.headers.get('x-real-ip') || 
                   null;
  const rateLimit = checkRateLimit(clientIp);
  
  if (!rateLimit.allowed) {
    return new Response(JSON.stringify({ 
      error: 'Rate limit exceeded', 
      message: 'Too many requests. Please try again later.' 
    }), {
      status: 429,
      headers: { 
        'Content-Type': 'application/json',
        'X-RateLimit-Remaining': '0',
        'Retry-After': '600'
      }
    });
  }

  try {
    // Input validation
    const body = await req.json();
    
    // Support both new format (photoKeys) and legacy format (images with base64/url)
    const photoKeys = body.photoKeys;
    const legacyImages = body.images;
    
    if (!photoKeys && !legacyImages) {
      return new Response(JSON.stringify({ error: 'photoKeys array or images array required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const imageCount = photoKeys ? photoKeys.length : (legacyImages ? legacyImages.length : 0);
    
    if (imageCount === 0) {
      return new Response(JSON.stringify({ error: 'At least one photo key or image is required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Limit number of images
    if (imageCount > 36) {
      return new Response(JSON.stringify({ error: 'Too many images (max 36)' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (imageCount < 6) {
      return new Response(JSON.stringify({ error: 'Too few images (min 6)' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Validate API key
    const apiKey = process.env.OPENAI_API_KEY;
    const hasApiKey = !!apiKey;
    console.log('[SEQUENCE] OPENAI_API_KEY exists:', hasApiKey);
    
    if (!apiKey) {
      console.error('[SEQUENCE] OPENAI_API_KEY is not set');
      return new Response(JSON.stringify({ error: 'OPENAI_API_KEY is not set' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
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
        return new Response(JSON.stringify({ 
          error: 'AWS credentials not configured. S3_BUCKET, AWS_ACCESS_KEY_ID, and AWS_SECRET_ACCESS_KEY must be set in Vercel environment variables.' 
        }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
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
        return new Response(JSON.stringify({ 
          error: "OpenAI auth failed", 
          openaiStatus: r.status, 
          openaiBody: json 
        }), {
          status: 502,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      const text = json.output_text || json.output || '';
      console.log('[SEQUENCE] OpenAI response text length:', text.length);

      // Parse JSON response
      let parsed: any;
      try {
        // Remove markdown code blocks if present
        const cleaned = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        parsed = JSON.parse(cleaned);
      } catch (parseError) {
        console.error('[SEQUENCE] JSON parse error:', parseError);
        console.error('[SEQUENCE] Response text snippet:', text.substring(0, 500));
        return new Response(JSON.stringify({ 
          error: 'Failed to parse OpenAI response as JSON',
          responseSnippet: text.substring(0, 500)
        }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // Validate order array
      if (!Array.isArray(parsed.order)) {
        return new Response(JSON.stringify({ error: 'Response missing valid "order" array' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // Ensure order contains all indices exactly once
      const expectedIndices = Array.from({ length: imageCount }, (_, i) => i);
      const orderSet = new Set(parsed.order);
      const hasAllIndices = expectedIndices.every(i => orderSet.has(i)) && parsed.order.length === imageCount;
      
      if (!hasAllIndices) {
        console.warn('[SEQUENCE] Order validation failed, using fallback');
        parsed.order = expectedIndices; // Fallback to original order
      }

      // Return response
      return new Response(JSON.stringify({
        order: parsed.order,
        beats: Array.isArray(parsed.beats) ? parsed.beats : undefined,
        rationale: typeof parsed.rationale === 'string' ? parsed.rationale : undefined
      }), {
        status: 200,
        headers: { 
          'Content-Type': 'application/json',
          'X-RateLimit-Remaining': rateLimit.remaining.toString()
        }
      });

    } catch (error: any) {
      clearTimeout(timeout);
      
      if (error.name === 'AbortError') {
        console.error('[SEQUENCE] Request timed out');
        return new Response(JSON.stringify({ error: 'Request timed out' }), {
          status: 504,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
      console.error('[SEQUENCE] Error calling OpenAI:', error);
      throw error;
    }

  } catch (error: any) {
    console.error('[SEQUENCE] Error:', error);
    return new Response(JSON.stringify({ 
      ok: false, 
      error: error.message || 'Unknown error' 
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

