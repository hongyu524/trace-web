/**
 * Vercel Serverless Function: Sequence Planning
 * Returns image ordering (currently returns original order)
 * OpenAI sequencing can be added later if needed
 * 
 * POST /api/sequence
 * Body: {
 *   photoKeys?: string[],
 *   images?: Array<{ id: string, url?: string, base64?: string, mimeType?: string }>,
 *   context?: string,
 *   aspectRatio?: string,
 *   frameRate?: number
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
    if (imageCount > 24) {
      return res.status(400).json({ error: 'Too many images (max 24)' });
    }

    if (imageCount < 6) {
      return res.status(400).json({ error: 'Too few images (min 6)' });
    }

    // Extract context (not currently used, but kept for future use)
    const context = typeof body.context === 'string' ? body.context.trim() : '';
    const aspectRatio = body.aspectRatio || '16:9';
    const frameRate = typeof body.frameRate === 'number' ? body.frameRate : 24;

    console.log(`[SEQUENCE] Processing ${imageCount} photos, context: "${context.substring(0, 50)}${context.length > 50 ? '...' : ''}"`);

    // Return sequence order (using original order for now - OpenAI sequencing can be added later)
    // Ensure sequence array is always present for backward compatibility
    const sequence = Array.isArray(photoKeys)
      ? photoKeys.map((key, i) => ({ key, order: i + 1 }))
      : [];

    // Extract order as number array (frontend expects order: number[])
    // Returns indices in original order [0, 1, 2, ..., n-1]
    const order = Array.isArray(photoKeys)
      ? photoKeys.map((_, i) => i)
      : [];

    console.log(`[SEQUENCE] Returning order for ${photoKeys.length} photos: [${order.slice(0, 5).join(', ')}${order.length > 5 ? '...' : ''}]`);

    // Return response
    res.setHeader('X-RateLimit-Remaining', rateLimit.remaining.toString());
    return res.status(200).json({
      ok: true,
      sequence,        // ALWAYS present, ALWAYS array
      order,           // ALWAYS present, ALWAYS array (for backward compatibility)
      photoKeys,       // keep
      narrative: "",   // Empty for now
    });

  } catch (error: any) {
    console.error('[SEQUENCE] Error:', error);
    return res.status(500).json({ 
      error: "sequence_failed",
      detail: String(error?.message || error || 'Unknown error')
    });
  }
}

