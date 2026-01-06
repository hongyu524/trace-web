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

// Helper to read headers in Node.js runtime
function getHeader(req: any, name: string): string | undefined {
  const key = name.toLowerCase();
  const val = req?.headers?.[key];
  return Array.isArray(val) ? val[0] : val;
}

export default async function handler(req: any, res: any) {
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
    return res.status(429).json({ 
      error: 'Rate limit exceeded', 
      message: 'Too many requests. Please try again later.' 
    });
  }

  try {
    // Input validation
    const body = req.body;
    
    if (!body || !body.images || !Array.isArray(body.images)) {
      return res.status(400).json({ error: 'images array required' });
    }

    if (body.images.length === 0) {
      return res.status(400).json({ error: 'images array cannot be empty' });
    }

    // Limit number of images
    if (body.images.length > 36) {
      return res.status(400).json({ error: 'Too many images (max 36)' });
    }

    if (body.images.length < 6) {
      return res.status(400).json({ error: 'Too few images (min 6)' });
    }

    // Validate API key
    const apiKey = process.env.OPENAI_API_KEY;
    const hasApiKey = !!apiKey;
    const apiKeyPrefix = apiKey ? apiKey.substring(0, 7) + '...' : 'missing';
    console.log('[SEQUENCE] OPENAI_API_KEY exists:', hasApiKey, 'prefix:', apiKeyPrefix);
    
    if (!apiKey) {
      console.error('[SEQUENCE] OPENAI_API_KEY is not set in environment variables');
      return res.status(500).json({ 
        error: 'OPENAI_API_KEY is not set',
        message: 'Please set OPENAI_API_KEY in Vercel environment variables. See SET_OPENAI_KEY.md for instructions.'
      });
    }
    
    if (!apiKey.startsWith('sk-')) {
      console.warn('[SEQUENCE] OPENAI_API_KEY does not start with "sk-", may be invalid');
    }

    const context = typeof body.context === 'string' ? body.context.trim() : '';
    const aspectRatio = body.aspectRatio || '16:9';
    const frameRate = typeof body.frameRate === 'number' ? body.frameRate : 24;

    // Build image content for OpenAI
    const imageContents = body.images.map((img: any, idx: number) => {
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

Analyze these ${body.images.length} images and determine the optimal cinematic ordering.
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
        
        // Provide more specific error messages
        let errorMessage = "OpenAI API error";
        if (r.status === 401) {
          errorMessage = "OpenAI API key is invalid or expired";
        } else if (r.status === 404) {
          errorMessage = "OpenAI API endpoint not found (check model name)";
        } else if (r.status === 429) {
          errorMessage = "OpenAI API rate limit exceeded";
        } else if (r.status >= 500) {
          errorMessage = "OpenAI API server error";
        }
        
        return res.status(502).json({ 
          error: errorMessage,
          details: r.status === 401 ? "Check your OPENAI_API_KEY in Vercel environment variables" : undefined,
          openaiStatus: r.status, 
          openaiBody: json 
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
        return res.status(500).json({ 
          error: 'Failed to parse OpenAI response as JSON',
          responseSnippet: text.substring(0, 500)
        });
      }

      // Validate order array
      if (!Array.isArray(parsed.order)) {
        return res.status(500).json({ error: 'Response missing valid "order" array' });
      }

      // Ensure order contains all indices exactly once
      const expectedIndices = Array.from({ length: body.images.length }, (_, i) => i);
      const orderSet = new Set(parsed.order);
      const hasAllIndices = expectedIndices.every(i => orderSet.has(i)) && parsed.order.length === body.images.length;
      
      if (!hasAllIndices) {
        console.warn('[SEQUENCE] Order validation failed, using fallback');
        parsed.order = expectedIndices; // Fallback to original order
      }

      // Return response
      return res.status(200).json({
        order: parsed.order,
        beats: Array.isArray(parsed.beats) ? parsed.beats : undefined,
        rationale: typeof parsed.rationale === 'string' ? parsed.rationale : undefined
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
      ok: false, 
      error: error.message || 'Unknown error' 
    });
  }
}
