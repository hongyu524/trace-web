import { useState, useEffect, useRef } from 'react';
import { Download, ArrowLeft, Unlock } from 'lucide-react';
import VideoGenerator from '../utils/VideoGenerator';
import { Plan } from '../types/plan';
import { apiUrl, fetchSignedVideoUrl } from '../utils/api';

interface VideoPreviewProps {
  data: {
    photos: Array<{ filename: string; width: number; height: number; path: string }> | File[];
    sessionId?: string;
    text?: string;
    remoteVideoPath?: string;
  };
  onBack: () => void;
}

export default function VideoPreview({ data, onBack }: VideoPreviewProps) {
  const [isGenerating, setIsGenerating] = useState(true);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isUnlocked, setIsUnlocked] = useState(false);
  const [showPayment, setShowPayment] = useState(false);
  const [progressPercent, setProgressPercent] = useState(0);
  const [progressStep, setProgressStep] = useState<string>('Starting...');
  const [progressDetail, setProgressDetail] = useState<string>('');
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    // If a remote path is provided, fetch a signed URL; otherwise, generate.
    if (data.remoteVideoPath) {
      loadRemoteVideo(data.remoteVideoPath);
    } else {
      generateVideo();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.remoteVideoPath]);

  // Debug: Log video URL changes
  useEffect(() => {
    if (videoUrl) {
      console.log('[VIDEO] Video URL set:', videoUrl);
    }
  }, [videoUrl]);

  const deriveResourcePath = (result: any, fallbackUrl?: string): string | null => {
    if (result?.s3Key && typeof result.s3Key === 'string') {
      const key = result.s3Key.startsWith('/') ? result.s3Key : `/${result.s3Key}`;
      if (key.startsWith('/videos/')) return key;
    }

    if (typeof fallbackUrl === 'string') {
      try {
        const u = new URL(fallbackUrl);
        if (u.pathname && u.pathname.startsWith('/videos/')) {
          return u.pathname;
        }
      } catch {
        // not a valid URL, try raw path
        if (fallbackUrl.startsWith('/videos/')) return fallbackUrl;
      }
    }
    return null;
  };

  const loadRemoteVideo = async (resourcePath: string) => {
    setIsGenerating(true);
    setError(null);
    setVideoUrl(null);
    try {
      const signed = await fetchSignedVideoUrl(resourcePath);
      const signedWithBust = `${signed}${signed.includes('?') ? '&' : '?'}t=${Date.now()}`;
      setVideoUrl(signedWithBust);
      setProgressPercent(100);
      setProgressStep('Ready');
      setProgressDetail('');
    } catch (err: any) {
      const message = err?.message || 'Failed to load video';
      setError(message);
      console.error('[VIDEO] Failed to fetch signed URL:', err);
    } finally {
      setIsGenerating(false);
    }
  };

  const generateVideo = async () => {
    setIsGenerating(true);
    setError(null);
    setVideoUrl(null);
    setPlan(null);
    setProgressPercent(0);
    setProgressStep('Starting...');
    setProgressDetail('');

    try {
      // Check if we have server-side photos (with sessionId) or client-side files
      if (data.sessionId && Array.isArray(data.photos) && data.photos.length > 0 && 'filename' in data.photos[0]) {
        // Server-side generation with SSE progress
        // Extract fps and outputRatio from data if available (defaults)
        const fps = (data as any).fps || 30;
        const outputRatio = (data as any).outputRatio || '16:9';
        
        // Request SSE stream for progress updates
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 360000); // 6 minutes
        
        let response;
        try {
          response = await fetch(apiUrl('api/create-memory?stream=true'), {
            method: 'POST',
            headers: { 
              'Content-Type': 'application/json',
              'Accept': 'text/event-stream'
            },
            body: JSON.stringify({
              sessionId: data.sessionId,
              photos: data.photos,
              promptText: data.text,
              fps: fps,
              outputRatio: outputRatio
            }),
            signal: controller.signal
          });
          clearTimeout(timeoutId);
        } catch (fetchError) {
          clearTimeout(timeoutId);
          if (fetchError instanceof Error && fetchError.name === 'AbortError') {
            throw new Error('Request timed out. Video generation is taking too long. Please try again with fewer photos or check server logs.');
          }
          throw fetchError;
        }

        // Check if this is SSE stream (text/event-stream) or regular JSON
        const contentType = response.headers.get('content-type') || '';
        const isSSE = contentType.includes('text/event-stream') || contentType.includes('event-stream');
        
        if (isSSE) {
          // Handle SSE stream
          await handleSSEStream(response, controller);
        } else {
          // Fallback to regular JSON response (no SSE support)
          await handleJSONResponse(response);
        }
      } else {
        // Fallback to client-side generation (for backward compatibility)
        const generator = new VideoGenerator();
        const videoBlob = await generator.createVideo(data.photos as File[], data.text);
        const url = URL.createObjectURL(videoBlob);
        setVideoUrl(url);
        setPlan(null);
        setProgressPercent(100);
        setProgressStep('Complete');
      }
    } catch (error) {
      // Extract error message safely - never access plan or plan.beats
      let errorMessage = 'Video generation failed. Please try again.';
      
      if (error instanceof Error) {
        // Use the error message string directly
        const rawMessage = error.message || '';
        if (rawMessage.toLowerCase().includes('beats')) {
          errorMessage = 'Video generation failed. Please try again.';
          console.error('[VIDEO] Error contained beats reference, using generic message');
        } else {
          errorMessage = rawMessage || errorMessage;
        }
      } else if (typeof error === 'string') {
        // If error string contains 'beats', replace it
        if (error.toLowerCase().includes('beats')) {
          errorMessage = 'Video generation failed. Please try again.';
          console.error('[VIDEO] Error string contained beats reference, using generic message');
        } else {
          errorMessage = error;
        }
      }
      
      console.error('[VIDEO] Generation failed:', errorMessage);
      // CRITICAL: Clear all state to prevent accessing beats on null
      setError(errorMessage);
      setVideoUrl(null);
      setPlan(null);
      // Ensure we don't have any memory data that could cause beats access
    } finally {
      setIsGenerating(false);
    }
  };

  // Handle SSE stream response
  const handleSSEStream = async (response: Response, controller: AbortController) => {
    if (!response.body) {
      throw new Error('Response body is null');
    }

    if (!response.ok) {
      // If response is not ok, try to parse error JSON
      try {
        const errorData = await response.json();
        throw new Error(errorData.error || errorData.message || `HTTP ${response.status}`);
      } catch {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let currentEventType = '';
    let result: any = null;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || ''; // Keep incomplete line in buffer

        for (const line of lines) {
          if (line.startsWith('event: ')) {
            currentEventType = line.substring(7).trim();
            continue;
          }

          if (line.startsWith('data: ')) {
            const dataStr = line.substring(6).trim();
            if (!dataStr) continue;

            try {
              const data = JSON.parse(dataStr);

              // Handle different event types
              if (currentEventType === 'error' || data.error) {
                // Error event
                throw new Error(data.error || data.message || 'Video generation failed');
              } else if (currentEventType === 'complete' || data.videoUrl || data.step === 'complete') {
                // Completion event
                result = data;
                setProgressPercent(100);
                setProgressStep('Complete');
                setProgressDetail('Video generation complete');
              } else if (currentEventType === 'progress' || data.percent !== undefined) {
                // Progress event
                setProgressPercent(Math.round(data.percent || 0));
                setProgressStep(data.step || 'Processing...');
                setProgressDetail(data.detail || '');
                console.log(`[PROGRESS] ${data.step}: ${(data.percent || 0).toFixed(1)}% - ${data.detail || ''}`);
              }
            } catch (parseError) {
              // If JSON parse fails, it might be a non-JSON data line, ignore
              if (parseError instanceof SyntaxError) {
                console.warn('[VIDEO] Failed to parse SSE data as JSON:', dataStr);
              } else {
                // Re-throw if it's not a parse error (e.g., our throw new Error above)
                throw parseError;
              }
            }
            
            // Reset event type after processing
            currentEventType = '';
          }
        }
      }

      // Process final result
      if (result && result.videoUrl) {
        const resourcePath = deriveResourcePath(result, result.videoUrl);
        if (resourcePath) {
          const signed = await fetchSignedVideoUrl(resourcePath);
          const videoUrlValue = `${signed}${signed.includes('?') ? '&' : '?'}t=${Date.now()}`;
          setVideoUrl(videoUrlValue);
        } else {
          const videoUrlValue = `${result.videoUrl}${result.videoUrl.includes('?') ? '&' : '?'}t=${Date.now()}`;
          setVideoUrl(videoUrlValue);
        }
        
        // Handle plan safely (same as before)
        setPlan(null);
        if (result.plan && typeof result.plan === 'object') {
          try {
            const rawPlan = result.plan;
            if (rawPlan !== null && !Array.isArray(rawPlan)) {
              let durations: number[] | undefined = undefined;
              if ('durations' in rawPlan && Array.isArray(rawPlan.durations)) {
                durations = rawPlan.durations;
              }
              
              if (durations && durations.length > 0) {
                const safePlan: Plan = {
                  selected: ('selected' in rawPlan && Array.isArray(rawPlan.selected)) 
                    ? Array.from(rawPlan.selected) 
                    : [],
                  order: ('order' in rawPlan && Array.isArray(rawPlan.order))
                    ? Array.from(rawPlan.order)
                    : [],
                  durations: Array.from(durations),
                  transitions: ('transitions' in rawPlan && Array.isArray(rawPlan.transitions))
                    ? Array.from(rawPlan.transitions)
                    : undefined,
                  memoryNote: ('memoryNote' in rawPlan && typeof rawPlan.memoryNote === 'string')
                    ? rawPlan.memoryNote
                    : undefined,
                  usedPlanner: ('usedPlanner' in rawPlan && 
                                (rawPlan.usedPlanner === 'ai' || rawPlan.usedPlanner === 'fallback'))
                    ? rawPlan.usedPlanner
                    : undefined
                };
                setPlan(safePlan);
              }
            }
          } catch (planError) {
            console.warn('[VIDEO] Plan processing skipped');
            setPlan(null);
          }
        }
      } else if (!result) {
        throw new Error('Video generation completed but no video URL received');
      }
    } finally {
      reader.releaseLock();
    }
  };

  // Handle regular JSON response (fallback)
  const handleJSONResponse = async (response: Response) => {
    // Try to parse JSON response (works for both success and error)
    let result = null;
    try {
      result = await response.json();
    } catch {
      // If JSON parse fails, ignore (we'll handle it below)
    }

    if (!response.ok) {
      // Extract error message from JSON response - use details field if available
      const details = result?.details || result?.message || result?.error || `HTTP ${response.status}`;
      
      // Log full error details - use multiple console.error calls so browser shows all details
      console.error('[VIDEO] ========================================');
      console.error('[VIDEO] create-memory failed');
      console.error('[VIDEO] Status:', response.status, response.statusText);
      console.error('[VIDEO] Error data:', result);
      console.error('[VIDEO] Error data (JSON):', JSON.stringify(result, null, 2));
      
      // Log step information if available
      if (result?.step) {
        console.error('[VIDEO] Error occurred at step:', result.step);
      }
      
      // Log FFmpeg stderr if available
      if (result?.ffmpegStderr) {
        console.error('[VIDEO] FFmpeg stderr:', result.ffmpegStderr);
      }
      
      // Sanitize error message for user display - remove beats references
      let displayMessage = typeof details === 'string' ? details : 'Video generation failed. Please try again.';
      if (displayMessage.toLowerCase().includes('beats')) {
        displayMessage = 'Video generation failed. Please check browser console for details.';
        console.error('[VIDEO] Error contained "beats" reference - original error was:', details);
      }
      
      console.error('[VIDEO] Throwing error with message:', displayMessage);
      console.error('[VIDEO] ========================================');
      
      // CRITICAL: Do NOT set any memory data - just throw error and show error UI
      // This prevents VideoPreview from trying to access beats on null data
      throw new Error(displayMessage);
    }
    
    // Success: use parsed result
    if (!result || typeof result !== 'object') {
      throw new Error('Invalid response from server');
    }
    
    // Extract videoUrl from response - backend returns absolute .mp4 URL (e.g., http://localhost:3001/outputs/filename.mp4)
    const videoUrlFromResponse = 'videoUrl' in result && typeof result.videoUrl === 'string' ? result.videoUrl : null;
    if (!videoUrlFromResponse) {
      throw new Error('videoUrl not found in response');
    }
    
    const resourcePath = deriveResourcePath(result, videoUrlFromResponse);
    let videoUrlValue = videoUrlFromResponse;
    if (resourcePath) {
      const signed = await fetchSignedVideoUrl(resourcePath);
      videoUrlValue = `${signed}${signed.includes('?') ? '&' : '?'}t=${Date.now()}`;
    } else {
      videoUrlValue = `${videoUrlFromResponse}${videoUrlFromResponse.includes('?') ? '&' : '?'}t=${Date.now()}`;
    }
    
    console.log('[VIDEO] Video URL:', videoUrlValue);
    // NEVER log the entire result object - it may contain plan with beats
    console.log('[VIDEO] Response received successfully');
    
    setVideoUrl(videoUrlValue);
    setProgressPercent(100);
    setProgressStep('Complete');
    
    // Handle plan completely separately and safely
    // CRITICAL: Never access plan.beats or other legacy fields
    setPlan(null); // Default to null, only set if we successfully extract safe plan
    
    try {
      // Check if plan exists in result using 'in' operator (safe check)
      if (result && typeof result === 'object' && 'plan' in result) {
        const rawPlan = result.plan;
        
        // Only process if plan is a non-null object (not array, not null)
        if (rawPlan !== null && rawPlan !== undefined && typeof rawPlan === 'object' && !Array.isArray(rawPlan)) {
          // Extract ONLY the fields we need using 'in' operator
          // NEVER access rawPlan.beats - it doesn't exist in our contract
          
          // Check for required field: durations
          let durations: number[] | undefined = undefined;
          if ('durations' in rawPlan && Array.isArray(rawPlan.durations)) {
            durations = rawPlan.durations;
          }
          
          if (durations && durations.length > 0) {
            // Build safe plan object field by field - explicitly exclude beats
            const safePlan: Plan = {
              selected: ('selected' in rawPlan && Array.isArray(rawPlan.selected)) 
                ? Array.from(rawPlan.selected) 
                : [],
              order: ('order' in rawPlan && Array.isArray(rawPlan.order))
                ? Array.from(rawPlan.order)
                : [],
              durations: Array.from(durations),
              transitions: ('transitions' in rawPlan && Array.isArray(rawPlan.transitions))
                ? Array.from(rawPlan.transitions)
                : undefined,
              memoryNote: ('memoryNote' in rawPlan && typeof rawPlan.memoryNote === 'string')
                ? rawPlan.memoryNote
                : undefined,
              usedPlanner: ('usedPlanner' in rawPlan && 
                            (rawPlan.usedPlanner === 'ai' || rawPlan.usedPlanner === 'fallback'))
                ? rawPlan.usedPlanner
                : undefined
            };
            
            setPlan(safePlan);
            console.log('[VIDEO] Plan stored successfully with', safePlan.durations.length, 'durations');
          }
        }
      }
    } catch (planError) {
      // If ANY error occurs during plan processing, silently ignore it - plan is optional
      // Don't even log the error message as it might contain beats references
      console.warn('[VIDEO] Plan processing skipped (optional field)');
      setPlan(null);
    }
    
    setError(null);
  };

  const handleUnlock = () => {
    setShowPayment(true);
  };

  const handlePaymentComplete = () => {
    setIsUnlocked(true);
    setShowPayment(false);
  };

  const handleDownload = () => {
    if (!videoUrl || !isUnlocked) return;

    const a = document.createElement('a');
    a.href = videoUrl;
    a.download = `trace-memory-${Date.now()}.webm`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };
  return (
    <div className="min-h-screen bg-black text-white">
      <div className="max-w-5xl mx-auto px-6 py-12">
        <button
          onClick={onBack}
          className="flex items-center space-x-2 text-gray-400 hover:text-white transition-colors mb-12"
        >
          <ArrowLeft className="w-4 h-4" />
          <span className="text-sm">Start Over</span>
        </button>

        {isGenerating ? (
          <div className="flex flex-col items-center justify-center min-h-[60vh] space-y-8 max-w-md mx-auto">
            <div className="w-full space-y-4">
              {/* Progress Bar */}
              <div className="w-full bg-gray-900 rounded-full h-2 overflow-hidden">
                <div 
                  className="h-full bg-white transition-all duration-300 ease-out"
                  style={{ width: `${progressPercent}%` }}
                />
              </div>
              
              {/* Progress Percentage and Step */}
              <div className="text-center space-y-2">
                <p className="text-2xl font-light">{progressPercent}%</p>
                <p className="text-lg font-light text-gray-300">
                  {progressStep === 'validating' ? 'Validating inputs...' :
                   progressStep === 'analyzing' ? 'Analyzing images...' :
                   progressStep === 'sequence-planning' ? 'Planning sequence...' :
                   progressStep === 'motion-planning' ? 'Planning motion...' :
                   progressStep === 'rendering' ? 'Rendering video...' :
                   progressStep === 'encoding' ? 'Encoding video...' :
                   progressStep === 'finalizing' ? 'Finalizing...' :
                   progressStep === 'Complete' || progressStep === 'complete' ? 'Complete!' :
                   'Creating your memory'}
                </p>
                {progressDetail && (
                  <p className="text-sm text-gray-500">{progressDetail}</p>
                )}
              </div>
            </div>
          </div>
        ) : error ? (
          <div className="flex flex-col items-center justify-center min-h-[60vh] space-y-6">
            <div className="text-center space-y-4 max-w-md">
              <h2 className="text-xl font-light text-gray-300">Memory Unavailable</h2>
              <p className="text-gray-500 text-sm">
                {typeof error === 'string' ? error : 'Video generation failed. Please try again.'}
              </p>
              <button
                onClick={onBack}
                className="mt-6 px-6 py-2 bg-white text-black rounded-sm hover:bg-gray-100 transition-colors text-sm font-medium"
              >
                Try Again
              </button>
            </div>
          </div>
        ) : !videoUrl ? (
          <div className="flex flex-col items-center justify-center min-h-[60vh] space-y-6">
            <div className="text-center space-y-4">
              <h2 className="text-xl font-light text-gray-300">Memory Unavailable</h2>
              <p className="text-gray-500 text-sm">Video could not be generated.</p>
              <button
                onClick={onBack}
                className="mt-6 px-6 py-2 bg-white text-black rounded-sm hover:bg-gray-100 transition-colors text-sm font-medium"
              >
                Try Again
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-8">
            <div className="relative aspect-video bg-gray-900 rounded-sm overflow-hidden">
              <video
                ref={videoRef}
                src={videoUrl}
                controls
                className="w-full h-full"
                loop
                preload="auto"
                onError={(e) => {
                  console.error('[VIDEO] Video load error:', e);
                  console.error('[VIDEO] Video URL was:', videoUrl);
                  const video = e.currentTarget;
                  if (video.error) {
                    console.error('[VIDEO] Video error code:', video.error.code);
                    console.error('[VIDEO] Video error message:', video.error.message);
                  }
                  setError(`Video failed to load. Please try again.`);
                }}
                onLoadedData={() => {
                  console.log('[VIDEO] Video loaded successfully, duration:', videoRef.current?.duration);
                }}
                onCanPlay={() => {
                  console.log('[VIDEO] Video can play');
                }}
                onLoadStart={() => {
                  console.log('[VIDEO] Video load started');
                }}
              />
              {!isUnlocked && (
                <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                  <div className="text-white/30 text-6xl font-light">PREVIEW</div>
                </div>
              )}
            </div>

            {/* Display memoryNote from plan, fallback to data.text */}
            {/* CRITICAL: Only access plan.memoryNote if plan exists and is valid object */}
            {(data.text || (plan !== null && plan !== undefined && typeof plan === 'object' && 'memoryNote' in plan && typeof plan.memoryNote === 'string')) && (
              <div className="text-center">
                <p className="text-gray-400 text-sm italic">
                  {(plan !== null && plan !== undefined && typeof plan === 'object' && 'memoryNote' in plan && typeof plan.memoryNote === 'string') 
                    ? plan.memoryNote 
                    : data.text}
                </p>
              </div>
            )}

            <div className="flex items-center justify-center gap-4">
              {!isUnlocked ? (
                <button
                  onClick={handleUnlock}
                  className="flex items-center space-x-2 px-8 py-3 bg-white text-black rounded-sm hover:bg-gray-100 transition-colors"
                >
                  <Unlock className="w-4 h-4" />
                  <span className="text-sm font-medium">Unlock Full Video</span>
                </button>
              ) : (
                <button
                  onClick={handleDownload}
                  className="flex items-center space-x-2 px-8 py-3 bg-white text-black rounded-sm hover:bg-gray-100 transition-colors"
                >
                  <Download className="w-4 h-4" />
                  <span className="text-sm font-medium">Download</span>
                </button>
              )}
            </div>

            <div className="text-center text-xs text-gray-600 space-y-1">
              <p>Your memory is {Math.floor(videoRef.current?.duration || 60)}s</p>
              <p className="text-gray-700">Crafted for emotion, not perfection</p>
            </div>
          </div>
        )}
      </div>

      {showPayment && (
        <div className="fixed inset-0 bg-black/90 flex items-center justify-center z-50 px-6">
          <div className="bg-gray-900 rounded-sm p-8 max-w-md w-full space-y-6">
            <div className="space-y-2">
              <h3 className="text-2xl font-light">Unlock Your Memory</h3>
              <p className="text-gray-400 text-sm">
                Remove the watermark and download your video
              </p>
            </div>

            <div className="border-t border-gray-800 pt-6 space-y-4">
              <div className="flex items-end justify-between">
                <span className="text-gray-400">One Memory</span>
                <span className="text-3xl font-light">$4.99</span>
              </div>
            </div>

            <div className="space-y-3 pt-4">
              <button
                onClick={handlePaymentComplete}
                className="w-full py-3 bg-white text-black rounded-sm hover:bg-gray-100 transition-colors text-sm font-medium"
              >
                Complete Purchase
              </button>
              <button
                onClick={() => setShowPayment(false)}
                className="w-full py-3 text-gray-400 hover:text-white transition-colors text-sm"
              >
                Not Yet
              </button>
            </div>

            <p className="text-xs text-gray-600 text-center">
              Payment processing placeholder for v1
            </p>
          </div>
        </div>
      )}

      <canvas ref={canvasRef} className="hidden" />
    </div>
  );
}
