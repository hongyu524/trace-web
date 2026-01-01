const API_BASE = import.meta.env.VITE_API_BASE_URL || "http://localhost:3001";

export type SignedUrlPayload = {
  signedUrl: string | null;
  cdnUrl: string | null;
  s3SignedUrl: string | null;
  preferred: string | null;
  resourcePath: string | null;
};

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

