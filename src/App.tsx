import { useState } from "react";
import LandingPage from "./components/LandingPage";
import UploadFlow from "./components/UploadFlow";
import PricingPage from "./components/PricingPage";
import EnterprisePage from "./components/EnterprisePage";
import CommunityPage from "./components/CommunityPage";
import Header from "./components/Header";
import "./index.css";

type Page = 'landing' | 'upload' | 'pricing' | 'enterprise' | 'community';

function App() {
  const [currentPage, setCurrentPage] = useState<Page>('landing');

  const handleNavigate = (page: Page) => {
    setCurrentPage(page);
  };

  const handleBack = () => {
    setCurrentPage('landing');
  };

  if (currentPage === 'upload') {
    return <UploadFlow onBack={handleBack} />;
  }

  if (currentPage === 'pricing') {
    return (
      <>
        <Header onNavigate={handleNavigate} />
        <PricingPage onBack={handleBack} />
      </>
    );
  }

  if (currentPage === 'enterprise') {
    return (
      <>
        <Header onNavigate={handleNavigate} />
        <EnterprisePage onBack={handleBack} />
      </>
    );
  }

  if (currentPage === 'community') {
    return (
      <>
        <Header onNavigate={handleNavigate} />
        <CommunityPage onBack={handleBack} />
      </>
    );
  }

  return (
    <>
      <Header onNavigate={handleNavigate} centered={true} />
      <LandingPage onStart={() => setCurrentPage('upload')} onNavigate={handleNavigate} />
    </>
  );
}

export default App;
