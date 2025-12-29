/**
 * API base URL configuration
 * Uses VITE_API_BASE_URL from environment, falls back to http://localhost:3001
 */
export const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || "http://localhost:3001";

// Debug: Log API base URL in development
if (import.meta.env.DEV) {
  console.log('[API] API_BASE_URL:', API_BASE_URL);
  console.log('[API] VITE_API_BASE_URL from env:', import.meta.env.VITE_API_BASE_URL);
}

/**
 * Helper to build API endpoint URLs
 */
export function apiUrl(endpoint: string): string {
  // Remove leading slash if present to avoid double slashes
  const cleanEndpoint = endpoint.startsWith('/') ? endpoint.slice(1) : endpoint;
  const url = `${API_BASE_URL}/${cleanEndpoint}`;
  
  // Debug: Log constructed URL in development
  if (import.meta.env.DEV) {
    console.log(`[API] apiUrl('${endpoint}') -> ${url}`);
  }
  
  return url;
}

/**
 * Fetch a signed CloudFront URL for a protected video path.
 * Expects resourcePath to start with /videos/.
 */
export async function fetchSignedVideoUrl(resourcePath: string): Promise<string> {
  if (typeof resourcePath !== 'string' || !resourcePath.startsWith('/videos/')) {
    throw new Error('resourcePath must start with /videos/');
  }

  const endpoint = apiUrl(`api/media/signed-url?path=${encodeURIComponent(resourcePath)}`);
  const res = await fetch(endpoint);

  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const data = await res.json();
      detail = data?.error || data?.message || detail;
    } catch {
      // ignore JSON parse errors
    }
    throw new Error(detail);
  }

  const data = await res.json();
  if (!data?.signedUrl || typeof data.signedUrl !== 'string') {
    throw new Error('signedUrl missing from response');
  }

  return data.signedUrl as string;
}

