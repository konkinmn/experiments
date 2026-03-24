import * as XLSX from 'xlsx';

export interface ColumnDef<T> {
  header: string;
  accessor: (row: T) => string | number | boolean | null | undefined;
}

export function downloadXlsx<T>(
  data: T[],
  columns: ColumnDef<T>[],
  filename: string,
) {
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

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Data');
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
