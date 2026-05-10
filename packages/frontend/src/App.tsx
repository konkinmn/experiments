import { Routes, Route, Navigate } from 'react-router-dom';
import { Sidebar } from '@/components/layout/Sidebar';
import { TimelineAnalyzer } from '@/pages/TimelineAnalyzer';
import { DatasetBuilder } from '@/pages/DatasetBuilder';
import { DatasetDetail } from '@/pages/DatasetDetail';
import { CaseBrowser } from '@/pages/CaseBrowser';

function App() {
  return (
    <div className="flex h-screen">
      <Sidebar />
      <Routes>
        <Route path="/" element={<Navigate to="/timeline-analyzer" replace />} />
        <Route path="/timeline-analyzer" element={<TimelineAnalyzer />} />
        <Route path="/dataset" element={<DatasetBuilder />} />
        <Route path="/dataset/:id" element={<DatasetDetail />} />
        <Route path="/case-browser" element={<CaseBrowser />} />
      </Routes>
    </div>
  );
}

export default App;
