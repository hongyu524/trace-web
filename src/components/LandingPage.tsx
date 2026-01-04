interface LandingPageProps {
  onStart: () => void;
  onNavigate?: (page: 'home' | 'pricing' | 'enterprise' | 'community') => void;
}

export default function LandingPage({ onStart, onNavigate }: LandingPageProps) {
  return (
    <div className="min-h-screen flex flex-col bg-gradient-to-b from-black via-gray-900 to-black">
      {/* Hero Section - Centered */}
      <div className="flex-1 flex flex-col items-center justify-center px-6 py-20 lg:py-32">
        <div className="max-w-2xl w-full text-center space-y-10">
          <div className="space-y-6">
            <div className="flex flex-col items-center justify-center">
              <img
                src="/trace_logo_1k_v2_hy001.png"
                alt="Trace"
                className="w-40 h-40 lg:w-48 lg:h-48 object-contain"
              />
            </div>

            <h1 className="text-4xl lg:text-5xl font-light text-white leading-tight">
              Some moments pass.<br />
              <span className="text-cyan-400">Some leave a trace.</span>
            </h1>
          </div>

          <p className="text-lg text-gray-300 leading-relaxed max-w-lg mx-auto">
            Upload your photos. We'll create one quiet, cinematic memory that preserves how it felt.
          </p>

          <div className="flex flex-col items-center space-y-4">
            <button
              onClick={onStart}
              className="group relative px-12 py-4 bg-white text-black text-base font-medium tracking-wide rounded-sm hover:bg-gray-100 transition-all duration-300 shadow-lg hover:shadow-xl hover:scale-105"
            >
              Create This Memory
              <div className="absolute inset-0 rounded-sm ring-1 ring-white/20 group-hover:ring-white/40 transition-all duration-300"></div>
            </button>

            <div className="pt-2 text-sm text-gray-500 space-y-1">
              <p className="font-medium text-gray-400">60–90 seconds</p>
              <p>No editing. No templates. Just emotion.</p>
            </div>
          </div>
        </div>
      </div>

      {/* Features Section - Below Hero */}
      <div className="border-t border-gray-800/50 py-20 px-6">
        <div className="max-w-6xl mx-auto">
          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-6 mb-20">
            <div className="bg-gray-800/30 backdrop-blur-sm border border-gray-700/30 rounded-lg p-6 hover:border-cyan-500/50 transition-all duration-300">
              <div className="text-cyan-400 text-2xl mb-3">✨</div>
              <h3 className="text-white font-medium mb-2">Cinematic Quality</h3>
              <p className="text-gray-400 text-sm leading-relaxed">Professional-grade video with smooth transitions and motion</p>
            </div>
            
            <div className="bg-gray-800/30 backdrop-blur-sm border border-gray-700/30 rounded-lg p-6 hover:border-cyan-500/50 transition-all duration-300">
              <div className="text-cyan-400 text-2xl mb-3">🎵</div>
              <h3 className="text-white font-medium mb-2">Curated Music</h3>
              <p className="text-gray-400 text-sm leading-relaxed">Perfect soundtrack selected to match your memories</p>
            </div>
            
            <div className="bg-gray-800/30 backdrop-blur-sm border border-gray-700/30 rounded-lg p-6 hover:border-cyan-500/50 transition-all duration-300">
              <div className="text-cyan-400 text-2xl mb-3">📸</div>
              <h3 className="text-white font-medium mb-2">Smart Sequencing</h3>
              <p className="text-gray-400 text-sm leading-relaxed">AI arranges your photos for the best storytelling flow</p>
            </div>
            
            <div className="bg-gray-800/30 backdrop-blur-sm border border-gray-700/30 rounded-lg p-6 hover:border-cyan-500/50 transition-all duration-300">
              <div className="text-cyan-400 text-2xl mb-3">⚡</div>
              <h3 className="text-white font-medium mb-2">Fast & Simple</h3>
              <p className="text-gray-400 text-sm leading-relaxed">Upload 6-36 photos and get your memory in minutes</p>
            </div>
          </div>

          {/* How It Works Section */}
          <div className="border-t border-gray-800/50 pt-16">
            <h2 className="text-2xl font-light text-white text-center mb-12">How It Works</h2>
            <div className="grid md:grid-cols-3 gap-12 max-w-4xl mx-auto">
              <div className="text-center space-y-4">
                <div className="w-16 h-16 mx-auto bg-cyan-500/10 border border-cyan-500/30 rounded-full flex items-center justify-center">
                  <span className="text-2xl font-bold text-cyan-400">1</span>
                </div>
                <h3 className="text-white font-medium text-lg">Upload Photos</h3>
                <p className="text-gray-400 text-sm leading-relaxed">Select 6-36 of your favorite photos. We support all common formats.</p>
              </div>
              
              <div className="text-center space-y-4">
                <div className="w-16 h-16 mx-auto bg-cyan-500/10 border border-cyan-500/30 rounded-full flex items-center justify-center">
                  <span className="text-2xl font-bold text-cyan-400">2</span>
                </div>
                <h3 className="text-white font-medium text-lg">AI Creates Magic</h3>
                <p className="text-gray-400 text-sm leading-relaxed">Our AI arranges, sequences, and adds cinematic motion to your memories.</p>
              </div>
              
              <div className="text-center space-y-4">
                <div className="w-16 h-16 mx-auto bg-cyan-500/10 border border-cyan-500/30 rounded-full flex items-center justify-center">
                  <span className="text-2xl font-bold text-cyan-400">3</span>
                </div>
                <h3 className="text-white font-medium text-lg">Share Your Memory</h3>
                <p className="text-gray-400 text-sm leading-relaxed">Download and share your 60-90 second cinematic memory film.</p>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Footer */}
      <footer className="border-t border-gray-800/50 py-8 px-6">
        <div className="max-w-6xl mx-auto text-center text-gray-500 text-sm">
          <p>© 2026 TRACE. Preserving moments, one memory at a time.</p>
        </div>
      </footer>
    </div>
  );
}
