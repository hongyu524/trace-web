import { useEffect, useState, useRef } from "react";
import { fetchSignedVideoPayload } from "../utils/api";

console.log('[BOOT] VideoPreview loaded from', import.meta.url, 'MODE=', import.meta.env.MODE);

type SignedPayload = {
  signedUrl: string | null;
  cdnUrl: string | null;
  s3SignedUrl: string | null;
  preferred: string | null;
  resourcePath: string | null;
};

interface VideoPreviewProps {
  path?: string;
  memoryId?: string;
  onBack?: () => void;
}

const FREE_DOWNLOADS_LIMIT = 3;
const DOWNLOAD_PRICE = 4.99;

function getFreeDownloadsUsed(): number {
  if (typeof window === 'undefined') return 0;
  const stored = localStorage.getItem('trace_free_downloads_used');
  return stored ? parseInt(stored, 10) : 0;
}

function incrementFreeDownloadsUsed(): void {
  if (typeof window === 'undefined') return;
  const current = getFreeDownloadsUsed();
  if (current < FREE_DOWNLOADS_LIMIT) {
    localStorage.setItem('trace_free_downloads_used', String(current + 1));
  }
}

function isMemoryPaid(memoryId: string): boolean {
  if (typeof window === 'undefined' || !memoryId) return false;
  return localStorage.getItem(`trace_paid_${memoryId}`) === 'true';
}

function markMemoryAsPaid(memoryId: string): void {
  if (typeof window === 'undefined' || !memoryId) return;
  localStorage.setItem(`trace_paid_${memoryId}`, 'true');
}

async function probePlaybackUrl(url: string) {
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        Range: 'bytes=0-2047',
      },
    });
    if (!res.ok) {
      throw new Error(`Probe failed: ${res.status} ${res.statusText}`);
    }
    const buf = new Uint8Array(await res.arrayBuffer());
    const hasFtyp = new TextDecoder('latin1').decode(buf.slice(0, 200)).includes('ftyp');
    console.log('[VIDEO][PROBE]', { url, status: res.status, hasFtyp, len: buf.length });
    if (!hasFtyp) {
      throw new Error('Playback URL failed probe (ftyp missing)');
    }
  } catch (err: any) {
    console.error('[VIDEO][PROBE] Error:', err);
    throw new Error(`Video file not accessible: ${err.message}`);
  }
}

export default function VideoPreview({ path: propPath, memoryId, onBack }: VideoPreviewProps = {}) {
  const [path, setPath] = useState<string>(propPath || '');
  const [videoSrc, setVideoSrc] = useState<string>('');
  const [error, setError] = useState<string>('');
  const [loading, setLoading] = useState<boolean>(true);
  const [showPaywall, setShowPaywall] = useState<boolean>(false);
  const [downloading, setDownloading] = useState<boolean>(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const downloadUrlRef = useRef<string | null>(null);

  const isDev = import.meta.env.DEV === true;

  // Extract memoryId from path if not provided
  useEffect(() => {
    if (!memoryId && path) {
      // Extract memoryId from path like /videos/published/{memoryId}-{timestamp}-{random}.mp4
      const match = path.match(/\/videos\/published\/([^-]+)-/);
      if (match && match[1]) {
        // Use the first part before the first dash as memoryId
        // But we need the full unique ID, so let's use the filename without extension
        const filename = path.split('/').pop()?.replace(/\.mp4$/, '') || '';
        // The memoryId is typically the first UUID-like segment
        const parts = filename.split('-');
        if (parts.length >= 2) {
          // Use first two parts as memoryId (UUID format)
          const extractedId = parts.slice(0, 2).join('-');
          console.log('[VIDEO] Extracted memoryId from path:', extractedId);
        }
      }
    }
  }, [path, memoryId]);

  useEffect(() => {
    if (!propPath) return;
    setPath(propPath);
  }, [propPath]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (!path) return;
      
      try {
        setLoading(true);
        setError('');
        console.log('[VIDEO] Fetching signed URL for path:', path);
        let payload: SignedPayload;
        try {
          payload = await fetchSignedVideoPayload(path, isDev ? 's3' : undefined);
          console.log('[VIDEO] Got payload from API:', payload);
        } catch (apiError: any) {
          console.error('[VIDEO] Failed to fetch signed URL from API:', apiError);
          throw new Error(`Failed to get video URL: ${apiError.message || 'Unknown error'}`);
        }
        const playbackUrl = isDev
          ? (payload.s3SignedUrl || payload.signedUrl || payload.cdnUrl)
          : (payload.cdnUrl || payload.signedUrl || payload.s3SignedUrl);

        if (!playbackUrl) throw new Error('No playable URL from backend');
        if (isDev && playbackUrl.includes('cloudfront.net')) {
          throw new Error('DEV MODE VIOLATION: CloudFront URL attempted: ' + playbackUrl);
        }

        // Store download URL
        downloadUrlRef.current = playbackUrl;

        console.log('[VIDEO] Probing playback URL:', playbackUrl);
        try {
          await probePlaybackUrl(playbackUrl);
          console.log('[VIDEO] Probe successful');
        } catch (probeError: any) {
          console.warn('[VIDEO] Probe failed, but will attempt to load video anyway:', probeError.message);
        }

        if (!cancelled) {
          setVideoSrc(playbackUrl);
          console.log('[VIDEO] MODE:', isDev ? 'DEV (S3 only)' : 'PROD (CDN preferred)', 'initialSrc=', playbackUrl);
        }
      } catch (err: any) {
        if (!cancelled) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          console.error('[VIDEO] Load error:', errorMsg);
          console.error('[VIDEO] Error object:', err);
          setError(errorMsg || 'Failed to load video');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [path, isDev]);

  useEffect(() => {
    if (videoRef.current && videoSrc) {
      const videoEl = videoRef.current;
      
      const handleError = (e: Event) => {
        console.error('[VIDEO] Video element error:', e);
        const error = videoEl.error;
        if (error) {
          let errorMsg = 'Failed to load video';
          if (error.code === error.MEDIA_ERR_ABORTED) {
            errorMsg = 'Video loading was aborted';
          } else if (error.code === error.MEDIA_ERR_NETWORK) {
            errorMsg = 'Network error while loading video';
          } else if (error.code === error.MEDIA_ERR_DECODE) {
            errorMsg = 'Video decoding error';
          } else if (error.code === error.MEDIA_ERR_SRC_NOT_SUPPORTED) {
            errorMsg = 'Video format not supported or file not found';
          }
          setError(errorMsg);
        }
      };
      
      videoEl.addEventListener('error', handleError);
      
      while (videoEl.firstChild) videoEl.removeChild(videoEl.firstChild);
      const source = document.createElement('source');
      source.src = videoSrc;
      source.type = 'video/mp4';
      videoEl.appendChild(source);
      videoEl.load();
      
      return () => {
        videoEl.removeEventListener('error', handleError);
      };
    }
  }, [videoSrc]);

  const handleDownload = async () => {
    if (!downloadUrlRef.current) {
      setError('Download URL not available');
      return;
    }

    // Extract memoryId from path if not provided
    let effectiveMemoryId = memoryId;
    if (!effectiveMemoryId && path) {
      const filename = path.split('/').pop()?.replace(/\.mp4$/, '') || '';
      effectiveMemoryId = filename;
    }

    if (!effectiveMemoryId) {
      setError('Memory ID not available');
      return;
    }

    const downloadsUsed = getFreeDownloadsUsed();
    const isPaid = isMemoryPaid(effectiveMemoryId);

    // Check if paywall should be shown
    if (downloadsUsed >= FREE_DOWNLOADS_LIMIT && !isPaid) {
      setShowPaywall(true);
      return;
    }

    // Proceed with download
    await performDownload(downloadUrlRef.current, effectiveMemoryId, !isPaid);
  };

  const performDownload = async (url: string, memId: string, isFree: boolean) => {
    setDownloading(true);
    try {
      // Create download link
      const link = document.createElement('a');
      link.href = url;
      link.download = `trace-${memId}.mp4`;
      link.style.display = 'none';
      document.body.appendChild(link);
      
      // Try to trigger download
      link.click();
      
      // Clean up
      setTimeout(() => {
        document.body.removeChild(link);
      }, 100);

      // If free download, increment counter
      if (isFree) {
        incrementFreeDownloadsUsed();
      }

      // Fallback: if download didn't work (cross-origin), open in new tab
      setTimeout(() => {
        // Check if download actually happened (heuristic: if link is still in DOM, it might have failed)
        // For cross-origin, browser will open new tab, which is acceptable fallback
        console.log('[DOWNLOAD] Download initiated');
      }, 500);
    } catch (err: any) {
      console.error('[DOWNLOAD] Error:', err);
      // Fallback: open in new tab
      window.open(url, '_blank');
    } finally {
      setDownloading(false);
    }
  };

  const handlePaywallPay = async () => {
    if (!downloadUrlRef.current) return;

    let effectiveMemoryId = memoryId;
    if (!effectiveMemoryId && path) {
      const filename = path.split('/').pop()?.replace(/\.mp4$/, '') || '';
      effectiveMemoryId = filename;
    }

    if (!effectiveMemoryId) {
      setError('Memory ID not available');
      return;
    }

    // Mark as paid (fake payment)
    markMemoryAsPaid(effectiveMemoryId);
    setShowPaywall(false);

    // Trigger download
    await performDownload(downloadUrlRef.current, effectiveMemoryId, false);
  };

  const downloadsUsed = typeof window !== 'undefined' ? getFreeDownloadsUsed() : 0;
  const remainingFree = Math.max(0, FREE_DOWNLOADS_LIMIT - downloadsUsed);
  const effectiveMemoryId = memoryId || (path ? path.split('/').pop()?.replace(/\.mp4$/, '') : '');
  const isPaid = effectiveMemoryId ? isMemoryPaid(effectiveMemoryId) : false;

  return (
    <div className="min-h-screen bg-gradient-to-b from-black via-gray-900 to-black">
      {/* Header with Back button */}
      <div className="px-6 pt-6 pb-4">
        <button
          onClick={onBack || (() => window.history.back())}
          className="text-gray-400 hover:text-white transition-colors flex items-center gap-2 text-sm"
        >
          <span>←</span>
          <span>Back to Upload</span>
        </button>
      </div>

      {/* Main Content */}
      <div className="flex flex-col items-center justify-center px-6 py-8 max-w-5xl mx-auto">
        {/* Title */}
        <h1 className="text-3xl font-light text-white mb-8 text-center">Your Memory Film</h1>

        {/* Video Player */}
        <div className="w-full max-w-[980px] mb-8">
          {loading && (
            <div className="w-full aspect-video bg-gray-800 rounded-lg flex items-center justify-center">
              <div className="text-gray-400">Loading video...</div>
            </div>
          )}
          {error && (
            <div className="w-full aspect-video bg-gray-800 rounded-lg flex items-center justify-center">
              <div className="text-red-400 text-center px-4">{error}</div>
            </div>
          )}
          {!loading && !error && (
            <div className="w-full" style={{ aspectRatio: '16/9' }}>
              <video
                ref={videoRef}
                controls
                className="w-full h-full rounded-lg bg-black"
                style={{ maxWidth: '100%', height: 'auto' }}
              >
                Your browser does not support HTML5 video.
              </video>
            </div>
          )}
        </div>

        {/* Action Buttons */}
        <div className="w-full max-w-[980px] space-y-4">
          <div className="flex gap-4 justify-center">
            <button
              onClick={handleDownload}
              disabled={downloading || !videoSrc || loading}
              className="px-8 py-3 bg-white text-black text-sm font-medium tracking-wide rounded-sm hover:bg-gray-100 transition-all duration-300 disabled:bg-gray-600 disabled:text-gray-400 disabled:cursor-not-allowed"
            >
              {downloading ? 'Downloading...' : 'Download MP4'}
            </button>
            <button
              onClick={onBack || (() => window.history.back())}
              className="px-8 py-3 bg-gray-800 border border-gray-700 text-white text-sm font-medium tracking-wide rounded-sm hover:bg-gray-700 transition-all duration-300"
            >
              Create Another
            </button>
          </div>

          {/* Download Info */}
          <p className="text-center text-gray-500 text-xs mt-4">
            {remainingFree > 0 ? (
              <span>{remainingFree} free download{remainingFree !== 1 ? 's' : ''} remaining. Then ${DOWNLOAD_PRICE.toFixed(2)} per download.</span>
            ) : isPaid ? (
              <span>This memory is unlocked.</span>
            ) : (
              <span>3 free downloads used. ${DOWNLOAD_PRICE.toFixed(2)} per download.</span>
            )}
          </p>
        </div>
      </div>

      {/* Paywall Modal */}
      {showPaywall && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-6">
          <div className="bg-gray-900 border border-gray-700 rounded-lg p-8 max-w-md w-full">
            <h2 className="text-2xl font-light text-white mb-4">Unlock Download</h2>
            <p className="text-gray-400 mb-6">
              You've used your 3 free downloads. Unlock this download for ${DOWNLOAD_PRICE.toFixed(2)}.
            </p>
            <div className="flex gap-4">
              <button
                onClick={handlePaywallPay}
                disabled={downloading}
                className="px-6 py-3 bg-white text-black text-sm font-medium tracking-wide rounded-sm hover:bg-gray-100 transition-all duration-300 disabled:bg-gray-600 disabled:text-gray-400 disabled:cursor-not-allowed flex-1"
              >
                {downloading ? 'Processing...' : `Pay $${DOWNLOAD_PRICE.toFixed(2)} (Dev)`}
              </button>
              <button
                onClick={() => setShowPaywall(false)}
                className="px-6 py-3 bg-gray-800 border border-gray-700 text-white text-sm font-medium tracking-wide rounded-sm hover:bg-gray-700 transition-all duration-300"
              >
                Not now
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
