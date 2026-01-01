import { useState } from "react";
import LandingPage from "./components/LandingPage";
import UploadFlow from "./components/UploadFlow";
import "./index.css";

function App() {
  const [showUpload, setShowUpload] = useState(false);

  if (showUpload) {
    return <UploadFlow />;
  }

  return <LandingPage onStart={() => setShowUpload(true)} />;
}

export default App;
