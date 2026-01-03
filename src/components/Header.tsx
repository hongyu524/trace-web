interface HeaderProps {
  onNavigate?: (page: 'home' | 'pricing' | 'enterprise' | 'community') => void;
}

export default function Header({ onNavigate }: HeaderProps) {

  return (
    <header className="w-full border-b border-black/50 bg-black/90 backdrop-blur-sm">
      <nav className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between">
        {/* Empty left side for balance */}
        <div className="w-24"></div>

        {/* Navigation Links - Center */}
        <div className="flex items-center space-x-8 absolute left-1/2 transform -translate-x-1/2">
          <button
            onClick={() => onNavigate?.('community')}
            className="text-white hover:text-cyan-400 transition-colors text-sm font-medium"
          >
            Community
          </button>
          
          <button
            onClick={() => onNavigate?.('enterprise')}
            className="text-white hover:text-cyan-400 transition-colors text-sm font-medium"
          >
            Enterprise
          </button>
          
          <button
            onClick={() => onNavigate?.('pricing')}
            className="text-white hover:text-cyan-400 transition-colors text-sm font-medium"
          >
            Pricing
          </button>
        </div>

        {/* Right side - empty for now, can add social icons later */}
        <div className="w-24"></div>
      </nav>
    </header>
  );
}
