// Railway backend API base URL (set in Vercel environment variables)
// In production, this MUST be set or API calls will fail
// In development, falls back to localhost:8080 if not set
const API_BASE = import.meta.env.VITE_API_BASE_URL || (import.meta.env.DEV ? "http://localhost:8080" : "");

// Production validation: ensure VITE_API_BASE_URL is set
if (import.meta.env.PROD && !API_BASE) {
  const errorMsg = 'VITE_API_BASE_URL is not set in production. Please configure it in Vercel environment variables.';
  console.error('[API] FATAL:', errorMsg);
  
  // Show error in UI if possible
  if (typeof window !== 'undefined') {
    document.body.innerHTML = `
      <div style="display: flex; align-items: center; justify-content: center; min-height: 100vh; font-family: system-ui; padding: 2rem;">
        <div style="max-width: 600px; text-align: center;">
          <h1 style="color: #ef4444; margin-bottom: 1rem;">Configuration Error</h1>
          <p style="color: #6b7280; margin-bottom: 0.5rem;">${errorMsg}</p>
          <p style="color: #9ca3af; font-size: 0.875rem;">Please contact the administrator.</p>
        </div>
      </div>
    `;
  }
  
  throw new Error(errorMsg);
}

// Diagnostics: log API_BASE at runtime (non-secret, for debugging)
if (typeof window !== 'undefined') {
  console.log('[API_BASE]', API_BASE || '(not set)');
  console.log('[SEQUENCE_URL]', '/api/sequence (same-origin Vercel)');
  console.log('[RAILWAY_URL]', API_BASE ? `${API_BASE}/api/create-memory` : '(API_BASE not set)');
}

export type SignedUrlPayload = {
  signedUrl: string | null;
  cdnUrl: string | null;
  s3SignedUrl: string | null;
  preferred: string | null;
  resourcePath: string | null;
};

export type SequenceResponse = {
  order: number[];
  beats?: string[];
  rationale?: string;
};

export type SequenceImage = {
  id: string;
  url?: string;
  base64?: string;
  mimeType?: string;
};

export type PresignedUploadResponse = {
  key: string;
  putUrl: string;
};

/**
 * Get presigned PUT URL for uploading a photo to S3
 * Calls Railway backend /api/media/presign-upload
 */
export async function getPresignedUploadUrl(
  fileName: string,
  contentType: string
): Promise<PresignedUploadResponse> {
  console.log('[API] Requesting presigned upload URL from Railway:', `${API_BASE}/api/media/presign-upload`);
  const response = await fetch(`${API_BASE}/api/media/presign-upload`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      fileName,
      contentType,
    }),
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({ error: 'Failed to get presigned upload URL' }));
    throw new Error(errorData.error || `Presigned upload API error (${response.status})`);
  }

  const data = await response.json();
  return data;
}

/**
 * Upload file directly to S3 using presigned PUT URL
 */
export async function uploadFileToS3(
  file: File,
  putUrl: string
): Promise<void> {
  console.log('[API] Uploading file to S3:', file.name, 'size:', file.size, 'bytes');
  const response = await fetch(putUrl, {
    method: 'PUT',
    headers: {
      'Content-Type': file.type,
    },
    body: file,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => 'Unknown error');
    throw new Error(`S3 upload failed (${response.status}): ${text}`);
  }

  console.log('[API] File uploaded successfully to S3');
}

/**
 * Get optimal image ordering from OpenAI
 * Calls Vercel serverless function /api/sequence (same-origin)
 * Now accepts S3 photo keys instead of base64 images
 */
export async function getImageSequenceFromKeys(
  photoKeys: string[],
  context?: string,
  aspectRatio?: string,
  frameRate?: number
): Promise<SequenceResponse> {
  const payload = {
    photoKeys,
    context,
    aspectRatio,
    frameRate,
  };
  const payloadJson = JSON.stringify(payload);
  const payloadSize = new Blob([payloadJson]).size;
  
  console.log('[API] Calling Vercel /api/sequence (same-origin)');
  console.log('[API] Sequence payload keys:', Object.keys(payload));
  console.log('[API] Sequence payload size:', payloadSize, 'bytes (', (payloadSize / 1024 / 1024).toFixed(2), 'MB)');
  console.log('[API] Number of photo keys:', photoKeys.length);
  
  const response = await fetch('/api/sequence', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: payloadJson,
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({ error: 'Failed to get sequence' }));
    throw new Error(errorData.error || `Sequence API error (${response.status})`);
  }

  const data = await response.json();
  return data;
}

/**
 * Analyze images using OpenAI Vision API
 * Calls Vercel serverless function /api/vision (same-origin)
 */
export async function analyzeImages(
  images: SequenceImage[]
): Promise<any[]> {
  console.log('[API] Calling Vercel /api/vision (same-origin)');
  const response = await fetch('/api/vision', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      images,
    }),
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({ error: 'Failed to analyze images' }));
    throw new Error(errorData.error || `Vision API error (${response.status})`);
  }

  const data = await response.json();
  return Array.isArray(data.analyses) ? data.analyses : [];
}

/**
 * Get optimal image ordering from OpenAI (LEGACY - uses base64)
 * @deprecated Use getImageSequenceFromKeys instead to avoid 413 errors
 */
export async function getImageSequence(
  images: SequenceImage[],
  context?: string,
  aspectRatio?: string,
  frameRate?: number
): Promise<SequenceResponse> {
  const payload = {
    images,
    context,
    aspectRatio,
    frameRate,
  };
  const payloadJson = JSON.stringify(payload);
  const payloadSize = new Blob([payloadJson]).size;
  
  console.log('[API] Calling Vercel /api/sequence (same-origin) - LEGACY base64 mode');
  console.log('[API] Sequence payload keys:', Object.keys(payload));
  console.log('[API] Sequence payload size:', payloadSize, 'bytes (', (payloadSize / 1024 / 1024).toFixed(2), 'MB)');
  console.log('[API] Number of images:', images.length);
  if (images.length > 0) {
    const firstImage = images[0];
    const imageDataSize = firstImage.base64 ? firstImage.base64.length : (firstImage.url ? firstImage.url.length : 0);
    console.log('[API] Sample image data size:', imageDataSize, 'bytes (first image, base64 length)');
  }
  
  const response = await fetch('/api/sequence', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: payloadJson,
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({ error: 'Failed to get sequence' }));
    throw new Error(errorData.error || `Sequence API error (${response.status})`);
  }

  const data = await response.json();
  return data;
}

export async function fetchSignedVideoPayload(path: string, prefer?: string): Promise<SignedUrlPayload> {
  console.log('[API] Calling Railway backend for signed URL:', `${API_BASE}/api/media/signed-url`);
  const params = new URLSearchParams({ path });
  if (prefer) params.set('prefer', prefer);
  const resp = await fetch(`${API_BASE}/api/media/signed-url?${params.toString()}`);
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Failed to fetch signed URL (${resp.status}): ${text}`);
  }
  const data = await resp.json();
  const signedUrl = data?.signedUrl ?? data?.s3SignedUrl ?? data?.cdnUrl ?? null;
  if (!signedUrl) {
    throw new Error('signedUrl missing from response');
  }
  return {
    signedUrl,
    cdnUrl: data?.cdnUrl ?? null,
    s3SignedUrl: data?.s3SignedUrl ?? null,
    preferred: data?.preferred ?? null,
    resourcePath: data?.resourcePath ?? null,
  };
}

export async function fetchPlaybackUrl(key: string): Promise<string> {
  console.log('[API] Calling Railway backend for playback URL:', `${API_BASE}/api/media/playback-url`);
  const params = new URLSearchParams({ key });
  const resp = await fetch(`${API_BASE}/api/media/playback-url?${params.toString()}`);
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Failed to fetch playback URL (${resp.status}): ${text}`);
  }
  const data = await resp.json();
  if (!data?.playbackUrl) {
    throw new Error('Playback URL missing in response');
  }
  return data.playbackUrl as string;
}
