import * as XLSX from 'xlsx';
import type { AnalysisResult } from '@/types';

function downloadFile(content: string | Blob, filename: string, mimeType: string) {
  const blob = content instanceof Blob ? content : new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

function getTimestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

export function exportToJson(results: AnalysisResult[], filenamePrefix: string = 'analysis') {
  const content = JSON.stringify(results, null, 2);
  const filename = `${filenamePrefix}-${getTimestamp()}.json`;
  downloadFile(content, filename, 'application/json');
}

export function exportToExcel(results: AnalysisResult[], filenamePrefix: string = 'analysis') {
  // Flatten results for Excel
  const rows = results.map((result) => {
    const baseRow = {
      caseId: result.caseId,
      status: result.error ? 'Error' : 'Success',
      error: result.error || '',
    };

    // If analysis is an object, spread its properties
    if (result.analysis && typeof result.analysis === 'object' && !Array.isArray(result.analysis)) {
      const analysis = result.analysis as Record<string, unknown>;
      const flattenedAnalysis: Record<string, string> = {};

      for (const [key, value] of Object.entries(analysis)) {
        if (typeof value === 'object' && value !== null) {
          flattenedAnalysis[key] = JSON.stringify(value);
        } else {
          flattenedAnalysis[key] = String(value ?? '');
        }
      }

      return { ...baseRow, ...flattenedAnalysis };
    }

    // Otherwise store full analysis as JSON string
    return {
      ...baseRow,
      analysis: result.analysis ? JSON.stringify(result.analysis) : '',
    };
  });

  const worksheet = XLSX.utils.json_to_sheet(rows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Analysis Results');

  // Auto-size columns
  const maxWidth = 50;
  const colWidths = Object.keys(rows[0] || {}).map((key) => ({
    wch: Math.min(
      maxWidth,
      Math.max(
        key.length,
        ...rows.map((row) => String((row as Record<string, unknown>)[key] || '').length)
      )
    ),
  }));
  worksheet['!cols'] = colWidths;

  const excelBuffer = XLSX.write(workbook, { bookType: 'xlsx', type: 'array' });
  const blob = new Blob([excelBuffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });

  const filename = `${filenamePrefix}-${getTimestamp()}.xlsx`;
  downloadFile(blob, filename, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
}
