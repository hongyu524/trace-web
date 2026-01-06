const API_BASE = import.meta.env.VITE_API_BASE_URL || "http://localhost:3001";
// Vercel API base - for OpenAI endpoints (sequence, vision)
const VERCEL_API_BASE = typeof window !== 'undefined' 
  ? window.location.origin 
  : 'https://tracememory.store';

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

/**
 * Get optimal image ordering from OpenAI
 * Calls Vercel serverless function /api/sequence
 */
export async function getImageSequence(
  images: SequenceImage[],
  context?: string,
  aspectRatio?: string,
  frameRate?: number
): Promise<SequenceResponse> {
  const response = await fetch(`${VERCEL_API_BASE}/api/sequence`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      images,
      context,
      aspectRatio,
      frameRate,
    }),
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({ error: 'Failed to get sequence' }));
    throw new Error(errorData.error || `Sequence API error (${response.status})`);
  }

  const data = await response.json();
  return data;
}

export async function fetchSignedVideoPayload(path: string, prefer?: string): Promise<SignedUrlPayload> {
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

export function resolvePlaybackUrl(input: any): string | null {
  if (!input) return null;
  if (typeof input === 'string') return input;
  return (
    input.playbackUrl ||
    input.cdnUrl ||
    input.videoUrl ||
    null
  );
}

export async function getPresignedUploadUrl(filename: string, mimeType: string): Promise<{ url: string; key: string }> {
  const resp = await fetch(`${API_BASE}/api/media/presign-upload`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filename, mimeType }),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Failed to get presigned URL (${resp.status}): ${text}`);
  }
  const data = await resp.json();
  return { url: data.url, key: data.key };
}

export async function uploadFileToS3(file: File, presignedUrl: string): Promise<void> {
  const resp = await fetch(presignedUrl, {
    method: 'PUT',
    headers: { 'Content-Type': file.type },
    body: file,
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Failed to upload file (${resp.status}): ${text}`);
  }
}

export async function getSequenceOrder(params: {
  photoKeys: string[];
  promptText?: string;
  outputRatio?: string;
  fps?: number;
}): Promise<{ order: number[] }> {
  // Use the Vercel API for sequence ordering
  const images: SequenceImage[] = params.photoKeys.map((key, idx) => ({
    id: String(idx),
    url: key, // Assuming key is a URL or will be resolved
  }));
  
  const response = await getImageSequence(
    images,
    params.promptText,
    params.outputRatio,
    params.fps
  );
  
  return { order: response.order };
}

export async function createMemoryRender(params: {
  photoKeys: string[];
  outputRatio: string;
  fps: number;
  promptText?: string;
}): Promise<{ path: string; memoryId: string }> {
  const resp = await fetch(`${API_BASE}/api/create-memory`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      photos: params.photoKeys.map(key => ({ key })),
      outputRatio: params.outputRatio,
      fps: params.fps,
      promptText: params.promptText || '',
    }),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Failed to create memory (${resp.status}): ${text}`);
  }
  const data = await resp.json();
  return { path: data.path || data.videoPath, memoryId: data.memoryId || data.id };
}

