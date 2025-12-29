import { useState } from 'react';
import LandingPage from './components/LandingPage';
import UploadFlow from './components/UploadFlow';
import VideoPreview from './components/VideoPreview';

type AppState = 'landing' | 'upload' | 'preview';

interface MemoryData {
  photos: Array<{ filename: string; width: number; height: number; path: string }> | File[];
  sessionId?: string;
  text?: string;
  fps?: 24 | 30;
  outputRatio?: '16:9' | '2.39:1' | '1:1';
}

function App() {
  const [state, setState] = useState<AppState>('landing');
  const [memoryData, setMemoryData] = useState<MemoryData | null>(null);

  const handleStart = () => {
    setState('upload');
  };

  const handleComplete = (data: MemoryData) => {
    setMemoryData(data);
    setState('preview');
  };

  const handleBack = () => {
    setState('landing');
    setMemoryData(null);
  };

  return (
    <div className="min-h-screen bg-black">
      {state === 'landing' && <LandingPage onStart={handleStart} />}
      {state === 'upload' && <UploadFlow onComplete={handleComplete} onBack={handleBack} />}
      {state === 'preview' && memoryData && <VideoPreview data={memoryData} onBack={handleBack} />}
    </div>
  );
}

export default App;
