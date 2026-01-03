interface HeaderProps {
  onNavigate?: (page: 'home' | 'pricing' | 'enterprise' | 'community') => void;
}

export default function Header({ onNavigate }: HeaderProps) {

  return (
    <header className="w-full border-b border-gray-800 bg-gray-900/80 backdrop-blur-sm">
      <nav className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between">
        {/* Logo - Left */}
        <div 
          className="flex items-center space-x-2 cursor-pointer hover:opacity-80 transition-opacity" 
          onClick={() => onNavigate?.('home')}
        >
          <div className="w-6 h-6 flex items-center justify-center">
            <div className="w-5 h-5 border-2 border-cyan-400 border-t-0 border-b-0">
              <div className="w-full h-full border-l-2 border-r-2 border-cyan-400"></div>
            </div>
          </div>
          <span className="text-lg font-semibold text-white">TRACE</span>
        </div>

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
