/**
 * Vercel Serverless Function: Vision Analysis (Optional)
 * Per-image detailed analysis for cinematic video planning
 * Uses OpenAI Responses API (/v1/responses) - server-side only
 * 
 * POST /api/vision
 * Body: {
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
    
    if (!body.images || !Array.isArray(body.images)) {
      return new Response(JSON.stringify({ error: 'images array required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (body.images.length === 0 || body.images.length > 36) {
      return new Response(JSON.stringify({ error: 'images array must have 1-36 items' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Validate API key
    const apiKey = process.env.OPENAI_API_KEY;
    const hasApiKey = !!apiKey;
    console.log('[VISION] OPENAI_API_KEY exists:', hasApiKey);
    
    if (!apiKey) {
      console.error('[VISION] OPENAI_API_KEY is not set');
      return new Response(JSON.stringify({ error: 'OPENAI_API_KEY is not set' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Analyze each image sequentially
    const frames = [];
    
    for (let i = 0; i < body.images.length; i++) {
      const img = body.images[i];
      
      // Get image URL
      let imageUrl: string;
      if (img.url) {
        imageUrl = img.url;
      } else if (img.base64) {
        const mimeType = img.mimeType || 'image/jpeg';
        imageUrl = `data:${mimeType};base64,${img.base64}`;
      } else {
        console.warn(`[VISION] Image ${i} (id: ${img.id}) missing url/base64, skipping`);
        continue;
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30000); // 30s per image
      
      try {
        const prompt = `Analyze this image for a cinematic memory video. Return JSON with:
- tags: array of descriptive tags
- mood: string describing the emotional tone
- subject: string describing the main subject
- qualityNotes: string with technical/composition notes
- suggestedRole: one of "opening", "middle", "climax", "ending", "transition"

Return ONLY valid JSON, no markdown.`;

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
                role: "user",
                content: [
                  { type: "input_text", text: prompt },
                  { type: "input_image", image_url: imageUrl }
                ]
              }
            ],
            max_output_tokens: 400,
          }),
          signal: controller.signal
        });

        clearTimeout(timeout);
        
        if (!r.ok) {
          console.error(`[VISION] OpenAI error for image ${i}:`, r.status);
          // Add fallback frame
          frames.push({
            index: i,
            tags: [],
            mood: 'unknown',
            subject: 'unknown',
            qualityNotes: 'Analysis failed',
            suggestedRole: 'middle' as const
          });
          continue;
        }

        const json = await r.json();
        const text = json.output_text || json.output || '';
        
        // Parse JSON
        let parsed: any;
        try {
          const cleaned = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
          parsed = JSON.parse(cleaned);
        } catch (parseError) {
          console.error(`[VISION] JSON parse error for image ${i}`);
          frames.push({
            index: i,
            tags: [],
            mood: 'unknown',
            subject: 'unknown',
            qualityNotes: 'Parse error',
            suggestedRole: 'middle' as const
          });
          continue;
        }

        frames.push({
          index: i,
          tags: Array.isArray(parsed.tags) ? parsed.tags : [],
          mood: typeof parsed.mood === 'string' ? parsed.mood : 'unknown',
          subject: typeof parsed.subject === 'string' ? parsed.subject : 'unknown',
          qualityNotes: typeof parsed.qualityNotes === 'string' ? parsed.qualityNotes : '',
          suggestedRole: ['opening', 'middle', 'climax', 'ending', 'transition'].includes(parsed.suggestedRole) 
            ? parsed.suggestedRole 
            : 'middle'
        });

        // Small delay to avoid rate limits
        if (i < body.images.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }

      } catch (error: any) {
        clearTimeout(timeout);
        if (error.name !== 'AbortError') {
          console.error(`[VISION] Error analyzing image ${i}:`, error.message);
        }
        frames.push({
          index: i,
          tags: [],
          mood: 'unknown',
          subject: 'unknown',
          qualityNotes: 'Analysis error',
          suggestedRole: 'middle' as const
        });
      }
    }

    return new Response(JSON.stringify({ frames }), {
      status: 200,
      headers: { 
        'Content-Type': 'application/json',
        'X-RateLimit-Remaining': rateLimit.remaining.toString()
      }
    });

  } catch (error: any) {
    console.error('[VISION] Error:', error);
    return new Response(JSON.stringify({ 
      ok: false, 
      error: error.message || 'Unknown error' 
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}
