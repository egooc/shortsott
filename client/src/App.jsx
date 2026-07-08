import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import Layout from './components/Layout';
import Settings from './pages/Settings';
import OttogiSourceDiscovery from './pages/OttogiSourceDiscovery';
import Phase1Search from './pages/Phase1Search';
import Phase2Analysis from './pages/Phase2Analysis';
import Phase3Script from './pages/Phase3Script';
import Phase4TTS from './pages/Phase4TTS';
import Phase5Draft from './pages/Phase5Draft';
import OttogiUpload from './pages/OttogiUpload';
import HighlightPatternAnalysis from './pages/HighlightPatternAnalysis';

export default function App() {
  return (
    <BrowserRouter>
      <Layout>
        <Routes>
          <Route path="/" element={<Navigate to="/phase-1" replace />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/phase-1" element={<OttogiSourceDiscovery />} />
          <Route path="/phase-2" element={<Phase2Analysis />} />
          <Route path="/phase-3" element={<OttogiUpload />} />
          <Route path="/phase-4" element={<Phase4TTS />} />
          <Route path="/phase-5" element={<Phase5Draft />} />
          <Route path="/highlight-patterns" element={<HighlightPatternAnalysis />} />
          <Route path="/virlo/source-discovery" element={<Phase1Search />} />
        </Routes>
      </Layout>
    </BrowserRouter>
  );
}
