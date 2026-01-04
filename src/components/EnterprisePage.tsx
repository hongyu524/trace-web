interface EnterprisePageProps {
  onBack: () => void;
}

export default function EnterprisePage({ onBack }: EnterprisePageProps) {
  return (
    <div className="h-screen flex flex-col bg-gradient-to-b from-black via-gray-900 to-black overflow-hidden">
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-4xl mx-auto px-6 py-8">
          <div className="flex items-start justify-between mb-8">
            <button
              onClick={onBack}
              className="text-gray-400 hover:text-white transition-colors flex items-center space-x-2"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
              </svg>
              <span>Back</span>
            </button>
          </div>

          <div className="mb-12">
            <h1 className="text-4xl font-bold text-white mb-4">Enterprise</h1>
            <p className="text-gray-400 text-lg">A product from Hesra</p>
          </div>

        <div className="space-y-12">
          {/* About Hesra */}
          <section>
            <h2 className="text-2xl font-semibold text-white mb-4">About Hesra</h2>
            <p className="text-gray-300 leading-relaxed">
              Hesra is a company dedicated to creating meaningful digital experiences that preserve and celebrate life's most important moments. 
              We believe technology should enhance human connection, not replace it.
            </p>
          </section>

          {/* Why Trace Matters */}
          <section>
            <h2 className="text-2xl font-semibold text-white mb-4">Why Trace Matters</h2>
            <div className="space-y-4 text-gray-300">
              <p className="leading-relaxed">
                In a world where we capture thousands of photos but rarely revisit them, Trace transforms your memories into 
                something you'll actually want to watch again and again.
              </p>
              <p className="leading-relaxed">
                We understand that the best memories aren't just about the images—they're about the feeling, the context, 
                the story. That's why Trace uses AI to understand the narrative behind your photos and creates a cinematic 
                experience that captures the emotion of the moment.
              </p>
              <p className="leading-relaxed">
                Every memory film is crafted with the same care and attention you'd give to a professional production, 
                but accessible to everyone. No editing skills required. No templates. Just pure emotion.
              </p>
            </div>
          </section>

          {/* Product Culture */}
          <section>
            <h2 className="text-2xl font-semibold text-white mb-4">Our Product Culture</h2>
            <div className="space-y-6">
              <div>
                <h3 className="text-xl font-medium text-cyan-400 mb-2">Simplicity Over Complexity</h3>
                <p className="text-gray-300 leading-relaxed">
                  We believe the best technology is invisible. Trace works quietly in the background, understanding your 
                  photos and creating something beautiful—no configuration, no learning curve.
                </p>
              </div>
              
              <div>
                <h3 className="text-xl font-medium text-cyan-400 mb-2">Emotion Over Features</h3>
                <p className="text-gray-300 leading-relaxed">
                  We don't add features for the sake of it. Every decision is made with one question in mind: 
                  "Will this help preserve the feeling of this moment?"
                </p>
              </div>
              
              <div>
                <h3 className="text-xl font-medium text-cyan-400 mb-2">Quality Over Quantity</h3>
                <p className="text-gray-300 leading-relaxed">
                  We'd rather create one perfect memory film than a hundred mediocre ones. That's why we focus on 
                  cinematic quality, thoughtful pacing, and emotional resonance in every video we generate.
                </p>
              </div>
            </div>
          </section>

          {/* Enterprise Solutions */}
          <section className="bg-gray-900/50 border border-gray-800 rounded-lg p-8">
            <h2 className="text-2xl font-semibold text-white mb-4">Enterprise Solutions</h2>
            <p className="text-gray-300 mb-6 leading-relaxed">
              Looking for Trace for your organization? We offer custom solutions for teams, agencies, and enterprises.
            </p>
            <ul className="space-y-3 mb-8">
              <li className="flex items-start space-x-3">
                <svg className="w-5 h-5 text-green-400 mt-0.5 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                </svg>
                <span className="text-gray-300">Custom branding and white-label options</span>
              </li>
              <li className="flex items-start space-x-3">
                <svg className="w-5 h-5 text-green-400 mt-0.5 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                </svg>
                <span className="text-gray-300">Bulk processing and API access</span>
              </li>
              <li className="flex items-start space-x-3">
                <svg className="w-5 h-5 text-green-400 mt-0.5 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                </svg>
                <span className="text-gray-300">Dedicated support and SLAs</span>
              </li>
              <li className="flex items-start space-x-3">
                <svg className="w-5 h-5 text-green-400 mt-0.5 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                </svg>
                <span className="text-gray-300">Custom integrations and workflows</span>
              </li>
            </ul>
            <a
              href="mailto:hesra.tech@gmail.com?subject=Trace Enterprise Inquiry&body=Hello Hesra team,%0D%0A%0D%0AI'm interested in learning more about Trace Enterprise solutions.%0D%0A%0D%0APlease contact me at your earliest convenience.%0D%0A%0D%0AThank you!"
              className="inline-block px-6 py-3 bg-cyan-500 text-black font-semibold rounded-sm hover:bg-cyan-400 transition-colors cursor-pointer"
              onClick={(e) => {
                // Ensure mailto link works
                window.location.href = 'mailto:hesra.tech@gmail.com?subject=Trace Enterprise Inquiry&body=Hello Hesra team,%0D%0A%0D%0AI\'m interested in learning more about Trace Enterprise solutions.%0D%0A%0D%0APlease contact me at your earliest convenience.%0D%0A%0D%0AThank you!';
              }}
            >
              Contact Us
            </a>
          </section>
        </div>
      </div>
      </div>
    </div>
  );
}

