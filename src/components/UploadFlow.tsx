import { useState, useRef } from 'react';
import { Upload, X, ArrowLeft } from 'lucide-react';
import { apiUrl } from '../utils/api';

interface UploadFlowProps {
  onComplete: (data: { 
    photos: Array<{ filename: string; width: number; height: number; path: string }> | File[];
    sessionId?: string;
    text?: string;
    fps?: 24 | 30;
    outputRatio?: '16:9' | '2.39:1' | '1:1';
  }) => void;
  onBack: () => void;
}

export default function UploadFlow({ onComplete, onBack }: UploadFlowProps) {
  const [photos, setPhotos] = useState<File[]>([]);
  const [memoryText, setMemoryText] = useState('');
  const [previews, setPreviews] = useState<string[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [fps, setFps] = useState<24 | 30>(30); // Default 30 fps
  const [outputRatio, setOutputRatio] = useState<'16:9' | '2.39:1' | '1:1'>('16:9'); // Default HD
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;

    const newPhotos = [...photos, ...files].slice(0, 36);
    setPhotos(newPhotos);

    files.forEach(file => {
      const reader = new FileReader();
      reader.onloadend = () => {
        setPreviews(prev => [...prev, reader.result as string].slice(0, 36));
      };
      reader.readAsDataURL(file);
    });
  };

  const removePhoto = (index: number) => {
    setPhotos(prev => prev.filter((_, i) => i !== index));
    setPreviews(prev => prev.filter((_, i) => i !== index));
  };

  const handleCreate = async () => {
    if (photos.length < 6) return;

    setIsProcessing(true);

    try {
      // Upload photos to server
      const sessionId = Date.now().toString();
      const formData = new FormData();
      photos.forEach(photo => {
        formData.append('photos', photo);
      });
      formData.append('sessionId', sessionId);

      const uploadRes = await fetch(apiUrl('api/upload-photos'), {
        method: 'POST',
        body: formData
      });

      if (!uploadRes.ok) {
        // Try to parse JSON error, fallback to status text
        let errorMessage = `Upload failed (${uploadRes.status})`;
        try {
          const errorJson = await uploadRes.json().catch(() => null);
          if (errorJson && typeof errorJson === 'object') {
            errorMessage = errorJson.message || errorJson.error || errorMessage;
          }
        } catch {
          // If JSON parse fails, try text
          try {
            const errorText = await uploadRes.text();
            if (errorText) {
              errorMessage = errorText;
            }
          } catch {
            // Use default message
          }
        }
        throw new Error(errorMessage);
      }

      const uploadData = await uploadRes.json();

      onComplete({
        photos: uploadData.photos,
        sessionId: uploadData.sessionId,
        text: memoryText.trim() || undefined,
        fps: fps,
        outputRatio: outputRatio
      } as any);
    } catch (error) {
      console.error('Upload failed:', error);
      const errorMessage = error instanceof Error ? error.message : 'Failed to upload photos. Please try again.';
      // Don't use alert - let the error propagate or show in UI
      alert(errorMessage);
      setIsProcessing(false);
    }
  };

  const canCreate = photos.length >= 6 && photos.length <= 36;

  return (
    <div className="min-h-screen bg-black text-white">
      <div className="max-w-4xl mx-auto px-6 py-12">
        <button
          onClick={onBack}
          className="flex items-center space-x-2 text-gray-400 hover:text-white transition-colors mb-12"
        >
          <ArrowLeft className="w-4 h-4" />
          <span className="text-sm">Back</span>
        </button>

        <div className="space-y-12">
          <div className="space-y-3">
            <h2 className="text-3xl font-light">Your Memory</h2>
            <p className="text-gray-400 text-sm">Upload 6–36 photos that matter</p>
          </div>

          <div className="space-y-6">
            <input
              type="text"
              value={memoryText}
              onChange={(e) => setMemoryText(e.target.value)}
              placeholder="A quiet moment together..."
              maxLength={60}
              className="w-full bg-transparent border-b border-gray-800 focus:border-gray-600 outline-none py-3 text-lg font-light placeholder-gray-700 transition-colors"
            />
            <p className="text-xs text-gray-600">Optional — one sentence to set the feeling</p>
          </div>

          <div className="space-y-6">
            {photos.length === 0 ? (
              <button
                onClick={() => fileInputRef.current?.click()}
                className="w-full aspect-video border border-dashed border-gray-800 hover:border-gray-600 rounded-sm flex flex-col items-center justify-center transition-colors space-y-3"
              >
                <Upload className="w-8 h-8 text-gray-700" strokeWidth={1.5} />
                <span className="text-sm text-gray-600">Choose moments that mattered — imperfect is fine.</span>
              </button>
            ) : (
              <div className="grid grid-cols-4 md:grid-cols-6 gap-3">
                {previews.map((preview, index) => (
                  <div key={index} className="relative aspect-square group">
                    <img
                      src={preview}
                      alt={`Memory ${index + 1}`}
                      className="w-full h-full object-cover rounded-sm"
                    />
                    <button
                      onClick={() => removePhoto(index)}
                      className="absolute top-1 right-1 bg-black/70 hover:bg-black rounded-full p-1 opacity-0 group-hover:opacity-100 transition-opacity"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                ))}

                {photos.length < 36 && (
                  <button
                    onClick={() => fileInputRef.current?.click()}
                    className="aspect-square border border-dashed border-gray-800 hover:border-gray-600 rounded-sm flex flex-col items-center justify-center transition-colors"
                  >
                    <Upload className="w-6 h-6 text-gray-700" strokeWidth={1.5} />
                    <span className="text-xs text-gray-700 mt-2">Add</span>
                  </button>
                )}
              </div>
            )}

            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              onChange={handleFileSelect}
              className="hidden"
            />

            <div className="space-y-3">
              <div className="flex items-center justify-between text-xs">
                <span className={`${photos.length < 6 ? 'text-gray-600' : 'text-gray-400'}`}>
                  {photos.length} of 36 photos
                </span>
                {photos.length < 6 && photos.length > 0 && (
                  <span className="text-gray-600">At least {6 - photos.length} more needed</span>
                )}
              </div>
              {photos.length > 0 && (
                <p className="text-xs text-gray-600">Your photos are private. This memory is yours.</p>
              )}
            </div>
          </div>

          <div className="space-y-4 pt-6">
            {/* FPS Selector */}
            <div className="flex items-center justify-between text-sm">
              <label className="text-gray-400">Frame rate:</label>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setFps(30)}
                  className={`px-4 py-2 rounded-sm transition-colors ${
                    fps === 30
                      ? 'bg-white text-black'
                      : 'bg-gray-900 text-gray-500 hover:text-gray-300'
                  }`}
                >
                  30 fps (Smooth)
                </button>
                <button
                  type="button"
                  onClick={() => setFps(24)}
                  className={`px-4 py-2 rounded-sm transition-colors ${
                    fps === 24
                      ? 'bg-white text-black'
                      : 'bg-gray-900 text-gray-500 hover:text-gray-300'
                  }`}
                >
                  24 fps (Cinematic)
                </button>
              </div>
            </div>

            {/* Output Ratio Selector */}
            <div className="flex items-center justify-between text-sm">
              <label className="text-gray-400">Output Ratio:</label>
              <select
                value={outputRatio}
                onChange={(e) => setOutputRatio(e.target.value as '16:9' | '2.39:1' | '1:1')}
                className="bg-gray-900 text-white border border-gray-700 rounded-sm px-3 py-2 text-sm focus:outline-none focus:border-gray-600"
              >
                <option value="16:9">HD (16:9)</option>
                <option value="2.39:1">Film Wide (2.39:1)</option>
                <option value="1:1">Square (1:1)</option>
              </select>
            </div>

            <button
              onClick={handleCreate}
              disabled={!canCreate || isProcessing}
              className={`w-full py-4 rounded-sm text-sm font-medium tracking-wide transition-all duration-300 ${
                canCreate && !isProcessing
                  ? 'bg-white text-black hover:bg-gray-100'
                  : 'bg-gray-900 text-gray-700 cursor-not-allowed'
              }`}
            >
              {isProcessing ? 'Processing...' : 'Create This Memory'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
