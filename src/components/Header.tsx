import { useState } from 'react';

interface HeaderProps {
  onNavigate?: (page: 'home' | 'pricing' | 'enterprise' | 'community') => void;
}

export default function Header({ onNavigate }: HeaderProps) {
  const [showResources, setShowResources] = useState(false);

  return (
    <header className="w-full border-b border-gray-800 bg-black/50 backdrop-blur-sm">
      <nav className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between">
        {/* Logo */}
        <div className="flex items-center space-x-3 cursor-pointer" onClick={() => onNavigate?.('home')}>
          <div className="w-8 h-8 flex items-center justify-center">
            <div className="w-6 h-6 border-2 border-cyan-400 border-t-0 border-b-0">
              <div className="w-full h-full border-l-2 border-r-2 border-cyan-400"></div>
            </div>
          </div>
          <span className="text-xl font-semibold text-cyan-400">TRACE</span>
        </div>

        {/* Navigation Links */}
        <div className="flex items-center space-x-8">
          <button
            onClick={() => onNavigate?.('community')}
            className="text-gray-400 hover:text-white transition-colors text-sm"
          >
            Community
          </button>
          
          <button
            onClick={() => onNavigate?.('enterprise')}
            className="text-gray-400 hover:text-white transition-colors text-sm"
          >
            Enterprise
          </button>
          
          <div className="relative">
            <button
              onClick={() => setShowResources(!showResources)}
              className="text-gray-400 hover:text-white transition-colors text-sm flex items-center space-x-1"
            >
              <span>Resources</span>
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </button>
            
            {showResources && (
              <div className="absolute top-full left-0 mt-2 w-48 bg-gray-900 border border-gray-800 rounded-lg shadow-xl py-2 z-50">
                <a href="#" className="block px-4 py-2 text-sm text-gray-300 hover:bg-gray-800 hover:text-white">
                  Documentation
                </a>
                <a href="#" className="block px-4 py-2 text-sm text-gray-300 hover:bg-gray-800 hover:text-white">
                  Support
                </a>
              </div>
            )}
          </div>
          
          <button
            onClick={() => onNavigate?.('pricing')}
            className="text-gray-400 hover:text-white transition-colors text-sm"
          >
            Pricing
          </button>
        </div>
      </nav>
    </header>
  );
}

