import * as XLSX from 'xlsx';

export interface ColumnDef<T> {
  header: string;
  accessor: (row: T) => string | number | boolean | null | undefined;
}

function buildSheet<T>(data: T[], columns: ColumnDef<T>[]): XLSX.WorkSheet {
  const headers = columns.map((col) => col.header);
  const rows = data.map((row) =>
    columns.map((col) => {
      const value = col.accessor(row);
      return value ?? '';
    }),
  );

  const worksheet = XLSX.utils.aoa_to_sheet([headers, ...rows]);

  // Auto-size columns
  worksheet['!cols'] = headers.map((header, i) => {
    const maxLen = Math.max(
      header.length,
      ...rows.map((row) => String(row[i]).length),
    );
    return { wch: Math.min(maxLen + 2, 50) };
  });

  return worksheet;
}

export function downloadXlsx<T>(
  data: T[],
  columns: ColumnDef<T>[],
  filename: string,
) {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, buildSheet(data, columns), 'Data');
  XLSX.writeFile(workbook, `${filename}.xlsx`);
}

/** A named, type-erased sheet for multi-sheet workbooks — create via makeSheet(). */
export interface SheetDef {
  name: string;
  build: () => XLSX.WorkSheet | null;
}

export function makeSheet<T>(name: string, rows: T[], columns: ColumnDef<T>[]): SheetDef {
  return { name, build: () => (rows.length > 0 ? buildSheet(rows, columns) : null) };
}

/** Empty sheets are skipped. Sheet names are capped at Excel's 31-char limit. */
export function downloadXlsxWorkbook(sheets: SheetDef[], filename: string) {
  const workbook = XLSX.utils.book_new();
  for (const sheet of sheets) {
    const ws = sheet.build();
    if (ws) XLSX.utils.book_append_sheet(workbook, ws, sheet.name.slice(0, 31));
  }
  XLSX.writeFile(workbook, `${filename}.xlsx`);
}

type PaginatedResponse<T> = { data: T[]; totalPages: number };

async function fetchAllPages<T>(
  fetchPage: (page: number) => Promise<PaginatedResponse<T>>,
): Promise<T[]> {
  const first = await fetchPage(1);
  const allData = [...first.data];
  for (let page = 2; page <= first.totalPages; page++) {
    const res = await fetchPage(page);
    allData.push(...res.data);
  }
  return allData;
}

export async function downloadXlsxAsync<T>(
  fetchPage: (page: number) => Promise<PaginatedResponse<T>>,
  columns: ColumnDef<T>[],
  filename: string,
): Promise<void> {
  const allData = await fetchAllPages(fetchPage);
  downloadXlsx(allData, columns, filename);
}
