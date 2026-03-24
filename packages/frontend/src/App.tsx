import { Routes, Route, Navigate } from 'react-router-dom';
import { Sidebar } from '@/components/layout/Sidebar';
import { TimelineAnalyzer } from '@/pages/TimelineAnalyzer';
import { RubricTester } from '@/pages/RubricTester';

function App() {
  return (
    <div className="flex h-screen">
      <Sidebar />
      <Routes>
        <Route path="/" element={<Navigate to="/timeline-analyzer" replace />} />
        <Route path="/timeline-analyzer" element={<TimelineAnalyzer />} />
        <Route path="/rubric-tester" element={<RubricTester />} />
      </Routes>
    </div>
  );
}

export default App;
