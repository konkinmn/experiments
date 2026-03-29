import { Link, useLocation } from "react-router-dom";
import { FlaskConical, Activity, Database } from "lucide-react";
import { cn } from "@/lib/utils";

export function Sidebar() {
  const location = useLocation();
  const isTimelineAnalyzerActive = location.pathname === '/timeline-analyzer';
  const isDatasetBuilderActive = location.pathname.startsWith('/dataset');

  return (
    <aside className="w-64 border-r border-gray-200 bg-white flex flex-col h-full">
      {/* Logo */}
      <div className="p-4 border-b border-gray-200">
        <div className="flex items-center gap-2">
          <FlaskConical className="h-6 w-6 text-blue-500" />
          <span className="font-semibold text-gray-900">Experiments</span>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto p-4">
        <p className="text-xs font-medium text-gray-400 uppercase tracking-wider mb-3">
          Tools
        </p>
        <nav className="space-y-1">
          <Link
            to="/timeline-analyzer"
            className={cn(
              "flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors",
              isTimelineAnalyzerActive
                ? "bg-blue-50 text-blue-600 font-medium"
                : "text-gray-600 hover:bg-gray-100"
            )}
          >
            <div className="h-6 w-6 rounded-full bg-blue-100 flex items-center justify-center">
              <Activity className="h-3.5 w-3.5 text-blue-600" />
            </div>
            <span>Case timeline analyzer</span>
          </Link>
          <Link
            to="/dataset"
            className={cn(
              "flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors",
              isDatasetBuilderActive
                ? "bg-blue-50 text-blue-600 font-medium"
                : "text-gray-600 hover:bg-gray-100"
            )}
          >
            <div className="h-6 w-6 rounded-full bg-blue-100 flex items-center justify-center">
              <Database className="h-3.5 w-3.5 text-blue-600" />
            </div>
            <span>Dataset Builder</span>
          </Link>
        </nav>
      </div>
    </aside>
  );
}
