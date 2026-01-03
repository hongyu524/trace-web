import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import './index.css';

// Build stamp for deployment verification
if (typeof window !== 'undefined') {
  console.log('TRACE BUILD', import.meta.env.VITE_GIT_SHA || import.meta.env.VITE_BUILD_TIME || 'no-build-info');
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
