interface HeaderProps {
  onNavigate?: (page: 'home' | 'pricing' | 'enterprise' | 'community') => void;
}

export default function Header({ onNavigate }: HeaderProps) {
  return (
    <header className="w-full bg-black/80 backdrop-blur-xl border-b border-white/5 sticky top-0 z-50">
      <nav className="max-w-7xl mx-auto px-6 lg:px-8 py-3 flex items-center justify-between">
        {/* Logo/Home - Left */}
        <button
          onClick={() => onNavigate?.('home')}
          className="flex items-center space-x-2 group"
        >
          <img
            src="/trace_logo_1k_v2_hy001.png"
            alt="TRACE"
            className="w-6 h-6 object-contain opacity-90 group-hover:opacity-100 transition-opacity"
          />
          <span className="text-white text-sm font-medium tracking-tight">TRACE</span>
        </button>

        {/* Navigation Links - Right (Apple-style) */}
        <div className="flex items-center space-x-6">
          <button
            onClick={() => onNavigate?.('community')}
            className="text-white/80 hover:text-white transition-colors text-sm font-normal"
          >
            Community
          </button>
          
          <button
            onClick={() => onNavigate?.('enterprise')}
            className="text-white/80 hover:text-white transition-colors text-sm font-normal"
          >
            Enterprise
          </button>
          
          <button
            onClick={() => onNavigate?.('pricing')}
            className="text-white/80 hover:text-white transition-colors text-sm font-normal"
          >
            Pricing
          </button>
        </div>
      </nav>
    </header>
  );
}
