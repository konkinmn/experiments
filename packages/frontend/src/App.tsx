import { Routes, Route, Navigate } from 'react-router-dom';
import { Sidebar } from '@/components/layout/Sidebar';
import { TimelineAnalyzer } from '@/pages/TimelineAnalyzer';
import { RubricTester } from '@/pages/RubricTester';
import { DatasetBuilder } from '@/pages/DatasetBuilder';
import { DatasetDetail } from '@/pages/DatasetDetail';

function App() {
  return (
    <div className="flex h-screen">
      <Sidebar />
      <Routes>
        <Route path="/" element={<Navigate to="/timeline-analyzer" replace />} />
        <Route path="/timeline-analyzer" element={<TimelineAnalyzer />} />
        <Route path="/rubric-tester" element={<RubricTester />} />
        <Route path="/dataset" element={<DatasetBuilder />} />
        <Route path="/dataset/:id" element={<DatasetDetail />} />
      </Routes>
    </div>
  );
}

export default App;
