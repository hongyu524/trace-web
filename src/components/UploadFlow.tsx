import { useState } from "react";
import VideoPreview from "./VideoPreview";

export default function UploadFlow() {
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

    try {
      // Convert files to base64
      const photos = await Promise.all(
        files.map(async (file) => {
          return new Promise<{ data: string; filename: string; mimeType: string }>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => {
              const base64 = reader.result as string;
              const base64Data = base64.split(",")[1];
              resolve({
                data: base64Data,
                filename: file.name,
                mimeType: file.type,
              });
            };
            reader.onerror = reject;
            reader.readAsDataURL(file);
          });
        })
      );

      // Use fetch with streaming response for SSE progress updates
      const API_BASE = import.meta.env.VITE_API_BASE_URL || "http://localhost:3001";
      const response = await fetch(`${API_BASE}/api/create-memory?stream=true`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": "text/event-stream",
        },
        body: JSON.stringify({
          photos,
          outputRatio,
          fps,
          promptText: promptText.trim(),
        }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ message: "Failed to create memory" }));
        throw new Error(errorData.message || "Failed to create memory");
      }

      // Read SSE stream
      const reader = response.body?.getReader();
      const decoder = new TextDecoder();
      
      if (!reader) {
        throw new Error("Stream not available");
      }

      let buffer = "";
      let currentEvent = "";
      
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          
          // Handle event type
          if (trimmed.startsWith("event: ")) {
            currentEvent = trimmed.slice(7).trim();
            continue;
          }
          
          // Handle data
          if (trimmed.startsWith("data: ")) {
            try {
              const data = JSON.parse(trimmed.slice(6));
              
              // Handle different event types
              if (currentEvent === "complete" || data.step === "complete") {
                setLoading(false);
                if (data.resourcePath) {
                  setVideoPath(data.resourcePath);
                  // Store memoryId if available from response
                  if (data.memoryId) {
                    setMemoryId(data.memoryId);
                  }
                }
                setProgress(null);
                return;
              } else if (currentEvent === "error" || data.step === "error") {
                setLoading(false);
                setError(data.error || "An unknown error occurred during video creation.");
                setProgress(null);
                return;
              } else {
                // Progress update (progress event or any other)
                setProgress({
                  percent: data.percent || 0,
                  step: data.step || "processing",
                  detail: data.detail || "",
                });
              }
            } catch (e) {
              console.error("Failed to parse SSE data:", e, line);
            }
            currentEvent = ""; // Reset after processing
          }
        }
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
    <div className="min-h-screen flex flex-col items-center justify-center px-6 bg-gradient-to-b from-black via-gray-900 to-black py-12">
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
