interface HeaderProps {
  onNavigate?: (page: 'home' | 'pricing' | 'enterprise' | 'community') => void;
  centered?: boolean;
}

export default function Header({ onNavigate, centered = false }: HeaderProps) {
  if (centered) {
    return (
      <header className="w-full bg-black border-b border-white/10 sticky top-0 z-50">
        <nav className="max-w-7xl mx-auto px-6 lg:px-8 py-4 flex items-center justify-center">
          {/* Navigation Links - Centered */}
          <div className="flex items-center space-x-8">
            <button
              onClick={() => onNavigate?.('community')}
              className="text-white/90 hover:text-white transition-colors text-sm font-normal"
            >
              Community
            </button>
            
            <button
              onClick={() => onNavigate?.('enterprise')}
              className="text-white/90 hover:text-white transition-colors text-sm font-normal"
            >
              Enterprise
            </button>
            
            <button
              onClick={() => onNavigate?.('pricing')}
              className="text-white/90 hover:text-white transition-colors text-sm font-normal"
            >
              Pricing
            </button>
          </div>
        </nav>
      </header>
    );
  }

  return (
    <header className="w-full bg-black border-b border-white/10 sticky top-0 z-50">
      <nav className="max-w-7xl mx-auto px-6 lg:px-8 py-4 flex items-center justify-between">
        {/* Navigation Links - Left */}
        <div className="flex items-center space-x-6">
          <button
            onClick={() => onNavigate?.('community')}
            className="text-white/90 hover:text-white transition-colors text-sm font-normal"
          >
            Community
          </button>
          
          <button
            onClick={() => onNavigate?.('enterprise')}
            className="text-white/90 hover:text-white transition-colors text-sm font-normal"
          >
            Enterprise
          </button>
          
          <button
            onClick={() => onNavigate?.('pricing')}
            className="text-white/90 hover:text-white transition-colors text-sm font-normal"
          >
            Pricing
          </button>
        </div>

        {/* Logo - Right */}
        <button
          onClick={() => onNavigate?.('home')}
          className="group"
        >
          <img
            src="/trace_logo_1k_v2_hy001.png"
            alt="TRACE"
            className="w-20 h-20 object-contain opacity-90 group-hover:opacity-100 transition-opacity"
          />
        </button>
      </nav>
    </header>
  );
}
