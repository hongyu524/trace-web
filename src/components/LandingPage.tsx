interface LandingPageProps {
  onStart: () => void;
}

export default function LandingPage({ onStart }: LandingPageProps) {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center px-6 bg-gradient-to-b from-black via-gray-900 to-black">
      <div className="max-w-2xl w-full text-center space-y-12">
        <div className="space-y-6">
          <div className="flex flex-col items-center justify-center">
            <img
              src="/trace_logo_1k_v2_hy001.png"
              alt="Trace"
              className="w-48 h-48 object-contain"
            />
          </div>

          <p className="text-xl text-gray-400 font-light leading-relaxed">
            Some moments pass. Some leave a trace.
          </p>
        </div>

        <div className="space-y-6 pt-8">
          <p className="text-gray-500 text-sm leading-relaxed max-w-md mx-auto">
            Upload your photos. We'll create one quiet, cinematic memory that preserves how it felt.
          </p>

          <p className="text-gray-600 text-sm max-w-md mx-auto">
            A 60–90 second memory film, created just for you.
          </p>

          <button
            onClick={onStart}
            className="group relative px-12 py-4 bg-white text-black text-sm font-medium tracking-wide rounded-sm hover:bg-gray-100 transition-all duration-300"
          >
            Create This Memory
            <div className="absolute inset-0 rounded-sm ring-1 ring-white/20 group-hover:ring-white/40 transition-all duration-300"></div>
          </button>
        </div>

        <div className="pt-8 text-xs text-gray-600 space-y-2">
          <p>60–90 seconds</p>
          <p className="text-gray-700">No editing. No templates. Just emotion.</p>
        </div>
      </div>
    </div>
  );
}
