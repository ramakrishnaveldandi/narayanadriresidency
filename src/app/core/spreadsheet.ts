/**
 * Thin wrapper around SheetJS. Loaded lazily (dynamic import) so residents
 * never download the spreadsheet library - only the admin screens use it.
 */
import type { Row } from './excel-import';

export interface RawSheet {
  name: string;
  rows: Row[];
}

export async function readWorkbook(data: ArrayBuffer): Promise<RawSheet[]> {
  const XLSX = await import('xlsx');
  const wb = XLSX.read(data, { type: 'array' });
  return wb.SheetNames.map((name) => ({
    name,
    rows: XLSX.utils.sheet_to_json<Row>(wb.Sheets[name], { header: 1, raw: true, defval: null }),
  }));
}

export async function downloadWorkbook(fileName: string, sheets: { name: string; rows: unknown[][] }[]): Promise<void> {
  const XLSX = await import('xlsx');
  const wb = XLSX.utils.book_new();
  for (const s of sheets) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(s.rows), s.name.slice(0, 31));
  XLSX.writeFile(wb, fileName);
}

export function downloadText(fileName: string, content: string, type = 'application/json'): void {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
