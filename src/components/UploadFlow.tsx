import { useState } from "react";
import VideoPreview from "./VideoPreview";
import { getSequenceOrder, createMemoryRender, getPresignedUploadUrl, uploadFileToS3 } from "../utils/api";

interface UploadFlowProps {
  onBack?: () => void;
}

export default function UploadFlow({ onBack }: UploadFlowProps) {
  const [files, setFiles] = useState<File[]>([]);
  const [filePreviews, setFilePreviews] = useState<string[]>([]);
  const [promptText, setPromptText] = useState<string>("");
  const [outputRatio, setOutputRatio] = useState<string>("16:9");
  const [fps, setFps] = useState<number>(24);
  const [videoPath, setVideoPath] = useState<string | null>(null);
  const [memoryId, setMemoryId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ percent: number; step: string; detail: string } | null>(null);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      const fileArray = Array.from(e.target.files);
      // Append new files to existing ones
      const updatedFiles = [...files, ...fileArray];
      
      // Limit to 36 photos max
      const finalFiles = updatedFiles.slice(0, 36);
      setFiles(finalFiles);
      
      // Generate preview URLs for new files only
      const newPreviews = fileArray.slice(0, 36 - files.length).map(file => URL.createObjectURL(file));
      setFilePreviews([...filePreviews, ...newPreviews].slice(0, 36));
      
      // Reset the input so same files can be selected again if needed
      e.target.value = '';
    }
  };

  const removeFile = (index: number) => {
    // Revoke the object URL to free memory
    if (filePreviews[index]) {
      URL.revokeObjectURL(filePreviews[index]);
    }
    
    const newFiles = files.filter((_, i) => i !== index);
    const newPreviews = filePreviews.filter((_, i) => i !== index);
    setFiles(newFiles);
    setFilePreviews(newPreviews);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (files.length < 6) {
      setError("Please upload at least 6 photos (maximum 36)");
      return;
    }

    setLoading(true);
    setError(null);
    setProgress(null); // Reset progress on new submission

    const API_BASE = import.meta.env.VITE_API_BASE_URL || (import.meta.env.DEV ? "http://localhost:8080" : "");
    if (!API_BASE) {
      setError("VITE_API_BASE_URL is not set. Cannot upload photos.");
      setLoading(false);
      return;
    }

    try {
      // Step 1: Upload photos to S3 first
      setProgress({ percent: 5, step: "uploading", detail: "Uploading photos to storage..." });

      const photoKeys: string[] = [];
      const totalFiles = files.length;

      // Upload each file to S3
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const uploadProgress = Math.floor((i / totalFiles) * 20) + 5; // 5-25%
        setProgress({
          percent: uploadProgress,
          step: "uploading",
          detail: `Uploading photo ${i + 1} of ${totalFiles}...`,
        });

        try {
          // Validate file size (max 12MB per file)
          const maxSize = 12 * 1024 * 1024; // 12MB
          if (file.size > maxSize) {
            throw new Error(`File "${file.name}" is too large (${(file.size / 1024 / 1024).toFixed(2)}MB). Maximum size is 12MB.`);
          }

          // Get presigned PUT URL from Railway
          const presignResponse = await getPresignedUploadUrl(file.name, file.type);
          
          // Upload file directly to S3 using the returned key
          await uploadFileToS3(file, presignResponse.url);
          
          photoKeys.push(presignResponse.key);
          console.log(`[UploadFlow] Uploaded ${i + 1}/${totalFiles}: ${presignResponse.key}`);
        } catch (uploadError: any) {
          console.error(`[UploadFlow] Upload failed for file ${i + 1}:`, uploadError.message);
          setError(`Failed to upload photo "${file.name}": ${uploadError.message}`);
          setLoading(false);
          setProgress(null);
          return; // Fail fast on upload error
        }
      }

      // Step 2: Get optimal image ordering from OpenAI via Vercel /api/sequence
      setProgress({ percent: 30, step: "analyzing", detail: "Determining optimal image sequence..." });
      
      console.log('[UploadFlow] Calling Vercel: /api/sequence');
      let optimalOrder: number[];
      try {
        const seq = await getSequenceOrder({
          photoKeys,
          context: promptText.trim() || undefined,
        });
        optimalOrder = seq.order;
        
        console.log('[UploadFlow] Sequence ordering received:', optimalOrder);
        
        // Fallback safety: if order is invalid, use default order
        if (!Array.isArray(optimalOrder) || optimalOrder.length !== photoKeys.length) {
          console.warn('[UploadFlow] Invalid order received, using default order');
          optimalOrder = Array.from({ length: photoKeys.length }, (_, i) => i);
        }
      } catch (seqError: any) {
        console.error('[UploadFlow] Sequence API failed:', seqError.message);
        setError(seqError.message || "Failed to analyze image sequence. Please try again.");
        setLoading(false);
        setProgress(null);
        return; // Stop execution on sequence API failure
      }

      // Step 3: Render video via Railway /api/create-memory
      setProgress({ percent: 50, step: "rendering", detail: "Creating your memory video..." });
      
      // Comprehensive logging before render request
      console.log('[CREATE_MEMORY] ========================================');
      console.log('[CREATE_MEMORY] FRONTEND_REQUEST_START');
      console.log('[CREATE_MEMORY] photoKeys.length =', photoKeys.length);
      console.log('[CREATE_MEMORY] photoKeys.first3 =', photoKeys.slice(0, 3));
      console.log('[CREATE_MEMORY] photoKeys.last3 =', photoKeys.slice(-3));
      console.log('[CREATE_MEMORY] aspectRatio =', outputRatio);
      console.log('[CREATE_MEMORY] fps =', fps);
      console.log('[CREATE_MEMORY] order.length =', optimalOrder.length);
      console.log('[CREATE_MEMORY] order.first5 =', optimalOrder.slice(0, 5));
      console.log('[CREATE_MEMORY] order.last5 =', optimalOrder.slice(-5));
      console.log('[CREATE_MEMORY] context.length =', (promptText.trim() || '').length);
      
      const motionPack = 'documentary'; // TODO: Add UI selector for motion pack
      const requestBody = {
        photoKeys,
        order: optimalOrder,
        aspectRatio: outputRatio,
        fps,
        context: promptText.trim() || undefined,
        motionPack,
      };
      console.log('[CREATE_MEMORY] sending', { motionPack, aspectRatio: outputRatio, fps, photoKeysCount: photoKeys.length });
      console.log('[CREATE_MEMORY] requestBody.photoKeys.length =', requestBody.photoKeys.length);
      console.log('[CREATE_MEMORY] requestBody.order.length =', requestBody.order.length);
      console.log('[CREATE_MEMORY] ========================================');
      console.log(`[UploadFlow] Calling Railway: ${API_BASE}/api/create-memory`);
      
      // Show gradual progress while rendering (time-based estimates)
      const startTime = Date.now();
      const estimatedRenderTime = 45000; // 45 seconds estimate
      let progressInterval: NodeJS.Timeout | null = null;
      
      try {
        progressInterval = setInterval(() => {
          const elapsed = Date.now() - startTime;
          const progressPercent = Math.min(95, 50 + (elapsed / estimatedRenderTime) * 45); // 50% to 95%
          const steps = [
            { min: 50, max: 60, detail: "Processing images..." },
            { min: 60, max: 85, detail: "Rendering video..." },
            { min: 85, max: 92, detail: "Applying effects..." },
            { min: 92, max: 97, detail: "Adding music..." },
            { min: 97, max: 100, detail: "Finalizing..." },
          ];
          const currentStep = steps.find(s => progressPercent >= s.min && progressPercent < s.max) || steps[steps.length - 1];
          setProgress({ percent: Math.floor(progressPercent), step: "rendering", detail: currentStep.detail });
        }, 500); // Update every 500ms

        const result = await createMemoryRender(requestBody);
        
        if (progressInterval) {
          clearInterval(progressInterval);
          progressInterval = null;
        }

        if (!result.ok || !result.playbackUrl) {
          throw new Error(result.detail || result.error || "Render failed.");
        }

        // Step 4: Show video
        setProgress({ percent: 100, step: "complete", detail: "Memory created successfully!" });
        setVideoPath(result.playbackUrl);
        if (result.jobId) {
          setMemoryId(result.jobId);
        }
        console.log('[UploadFlow] Memory created successfully:', result.videoKey);
        
      } catch (renderError: any) {
        if (progressInterval) {
          clearInterval(progressInterval);
        }
        console.error('[UploadFlow] Render failed:', renderError.message);
        setError(renderError.message || "Failed to create memory video. Please try again.");
        setLoading(false);
        setProgress(null);
        return;
      }
    } catch (err: any) {
      setError(err.message || "Failed to create video");
      setLoading(false);
      setProgress(null);
    }
  };

  if (videoPath) {
    return (
      <VideoPreview 
        path={videoPath} 
        memoryId={memoryId || undefined}
        onBack={() => {
          setVideoPath(null);
          setMemoryId(null);
        }}
      />
    );
  }

  return (
    <div className="min-h-screen flex flex-col items-center justify-center px-6 bg-gradient-to-b from-black via-gray-900 to-black py-12 relative">
      {/* Back Button */}
      {onBack && (
        <button
          onClick={onBack}
          className="absolute top-6 left-6 text-gray-400 hover:text-white transition-colors flex items-center space-x-2 z-10"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
          <span>Back</span>
        </button>
      )}
      
      {/* Logo (optional - keeping it subtle) */}
      <div className="absolute top-6 right-6 flex items-center space-x-2">
        <div className="w-6 h-6 flex items-center justify-center">
          <div className="w-5 h-5 border-2 border-cyan-400 border-t-0 border-b-0">
            <div className="w-full h-full border-l-2 border-r-2 border-cyan-400"></div>
          </div>
        </div>
        <span className="text-sm font-semibold text-cyan-400">TRACE</span>
      </div>

      <div className="max-w-4xl w-full space-y-8">
        <div className="text-center space-y-4">
          <h1 className="text-3xl font-light text-white">Create Your Memory</h1>
          <p className="text-gray-400 text-sm">Upload 6-36 photos to create your cinematic memory film</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-8">
          <div>
            <label className="block text-gray-300 text-sm font-medium mb-3">
              Upload Photos
            </label>
            <div className="flex gap-3">
              <input
                type="file"
                multiple
                accept="image/*"
                onChange={handleFileChange}
                id="file-input"
                className="hidden"
              />
              <label
                htmlFor="file-input"
                className="cursor-pointer px-4 py-2 bg-gray-800 border border-gray-700 text-white rounded-sm hover:bg-gray-700 transition-colors"
              >
                Choose Files
              </label>
              {files.length > 0 && files.length < 36 && (
                <label
                  htmlFor="file-input"
                  className="cursor-pointer px-4 py-2 bg-gray-700 border border-gray-600 text-white rounded-sm hover:bg-gray-600 transition-colors"
                >
                  Add More Photos
                </label>
              )}
            </div>
            {files.length > 0 && (
              <p className="mt-2 text-gray-500 text-sm">
                {files.length} photo{files.length !== 1 ? "s" : ""} selected
              </p>
            )}
          </div>
          
          {/* Prompt/Storytelling Context */}
          <div>
            <label className="block text-gray-300 text-sm font-medium mb-2">
              Storytelling Context <span className="text-gray-500 font-normal">(Optional)</span>
            </label>
            <textarea
              value={promptText}
              onChange={(e) => setPromptText(e.target.value)}
              placeholder="Describe the story or mood you want to capture... (e.g., &quot;A quiet weekend getaway with friends&quot;, &quot;Celebrating graduation with family&quot;)"
              rows={3}
              className="w-full px-4 py-3 bg-gray-800 border border-gray-700 text-white rounded-sm focus:outline-none focus:border-gray-600 resize-none placeholder:text-gray-600"
            />
            <p className="mt-1 text-xs text-gray-500">
              Help the AI understand the context to create a better storytelling order
            </p>
          </div>

          {/* Image Preview Gallery */}
          {filePreviews.length > 0 && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <h2 className="text-lg font-medium text-white">Selected Photos</h2>
                <span className="text-sm text-gray-400">{files.length} / 36</span>
              </div>
              <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 gap-4">
                {filePreviews.map((preview, index) => (
                  <div
                    key={index}
                    className="group relative aspect-square rounded-lg overflow-hidden bg-gray-800 border border-gray-700 hover:border-gray-600 transition-all"
                  >
                    <img
                      src={preview}
                      alt={`Preview ${index + 1}`}
                      className="w-full h-full object-cover"
                    />
                    <button
                      type="button"
                      onClick={() => removeFile(index)}
                      className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center"
                    >
                      <svg
                        className="w-6 h-6 text-white"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M6 18L18 6M6 6l12 12"
                        />
                      </svg>
                    </button>
                    <div className="absolute top-1 left-1 bg-black/70 text-white text-xs px-1.5 py-0.5 rounded">
                      {index + 1}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div>
              <label className="block text-gray-300 text-sm font-medium mb-2">
                Aspect Ratio
              </label>
              <select
                value={outputRatio}
                onChange={(e) => setOutputRatio(e.target.value)}
                className="w-full px-4 py-2 bg-gray-800 border border-gray-700 text-white rounded-sm focus:outline-none focus:border-gray-600"
              >
                <option value="16:9" className="bg-gray-800">16:9 (HD)</option>
                <option value="2.39:1" className="bg-gray-800">2.39:1 (Film Wide)</option>
                <option value="1:1" className="bg-gray-800">1:1 (Square)</option>
              </select>
            </div>

            <div>
              <label className="block text-gray-300 text-sm font-medium mb-2">
                Frame Rate
              </label>
              <select
                value={fps}
                onChange={(e) => setFps(Number(e.target.value))}
                className="w-full px-4 py-2 bg-gray-800 border border-gray-700 text-white rounded-sm focus:outline-none focus:border-gray-600"
              >
                <option value={24} className="bg-gray-800">24 fps (Cinematic)</option>
                <option value={30} className="bg-gray-800">30 fps (Smooth)</option>
              </select>
            </div>
          </div>

          {progress && (
            <div className="space-y-2">
              <div className="w-full bg-gray-800 rounded-full h-2.5 dark:bg-gray-700">
                <div
                  className="bg-blue-600 h-2.5 rounded-full transition-all duration-300"
                  style={{ width: `${Math.min(100, Math.max(0, progress.percent))}%` }}
                ></div>
              </div>
              <p className="text-sm text-gray-400">
                {progress.step}: {progress.detail} ({progress.percent.toFixed(1)}%)
              </p>
            </div>
          )}

          {error && (
            <div className="p-4 bg-red-900/20 border border-red-800 text-red-300 rounded-sm text-sm">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading || files.length < 6}
            className="w-full group relative px-12 py-4 bg-white text-black text-sm font-medium tracking-wide rounded-sm hover:bg-gray-100 transition-all duration-300 disabled:bg-gray-600 disabled:text-gray-400 disabled:cursor-not-allowed"
          >
            {loading ? "Creating Memory..." : "Create Memory"}
            <div className="absolute inset-0 rounded-sm ring-1 ring-white/20 group-hover:ring-white/40 transition-all duration-300"></div>
          </button>
        </form>
      </div>
    </div>
  );
}
