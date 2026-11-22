/**
 * Pure (framework-free) logic that turns a sheet - given as an array of rows -
 * into a MonthBill draft. Kept free of Angular and SheetJS so it can be unit
 * tested and reused from Node scripts.
 */
import type { BillColumn, CellValue, ColumnRole, FlatBill, MonthBill, MonthKey } from './models';

export interface ColumnRule {
  /** Regex (case-insensitive) tested against the normalised header. */
  match: string;
  /** Which matching column this rule applies to (1 = first match). Omit to apply to every match. */
  occurrence?: number;
  role: ColumnRole;
  label?: string;
}

export interface ImportTemplate {
  name: string;
  rules: ColumnRule[];
}

export interface ImportDraft {
  headerRowIndex: number;
  title: string;
  detectedMonth: MonthKey | null;
  columns: BillColumn[];
  flats: FlatBill[];
}

export interface ValidationResult {
  errors: string[];
  warnings: string[];
}

export type Row = unknown[];

export function normalizeHeader(h: unknown): string {
  return String(h ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function slug(h: string): string {
  return normalizeHeader(h).replace(/ /g, '_') || 'col';
}

export function toNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const s = v.replace(/[,\s₹]/g, '').replace(/^rs\.?/i, '');
    if (s === '' || !/^-?\d*\.?\d+$/.test(s)) return null;
    return Number(s);
  }
  return null;
}

function toCell(v: unknown): CellValue {
  if (v === null || v === undefined || v === '') return null;
  const n = toNumber(v);
  if (n !== null) return n;
  return String(v).trim();
}

/** The header row is the first row (within the first 15) that has a cell reading "Flat"/"Flat No"/"Unit". */
export function detectHeaderRow(rows: Row[]): number {
  const limit = Math.min(rows.length, 15);
  for (let i = 0; i < limit; i++) {
    if ((rows[i] ?? []).some((c) => /^(flat|flat no|flat number|unit|door no)$/.test(normalizeHeader(c)))) return i;
  }
  return -1;
}

const MONTH_NAMES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** Detects "OCT 26", "Oct-2026", "October 2026", "2026-10" in a title or file name. */
export function detectMonth(...texts: string[]): MonthKey | null {
  for (const raw of texts) {
    const t = (raw ?? '').toLowerCase();
    const iso = t.match(/(20\d{2})[-_ ](0[1-9]|1[0-2])(?!\d)/);
    if (iso) return `${iso[1]}-${iso[2]}`;
    const m = t.match(/(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*[\s\-_'.,]*(\d{4}|\d{2})(?!\d)/);
    if (m) {
      const month = MONTH_NAMES.indexOf(m[1]) + 1;
      const year = m[2].length === 2 ? 2000 + Number(m[2]) : Number(m[2]);
      return `${year}-${String(month).padStart(2, '0')}`;
    }
  }
  return null;
}

const GENERIC_TOTAL = /^(grand total|total|total due|total amount|amount due|net payable|net amount)$/;

/** Assigns a role and label to every header using the template, then generic fallbacks. */
export function buildColumns(header: Row, template?: ImportTemplate): BillColumn[] {
  const usedKeys = new Map<string, number>();
  const columns: BillColumn[] = header.map((h, index) => {
    const text = String(h ?? '').trim();
    const base = slug(text);
    const n = (usedKeys.get(base) ?? 0) + 1;
    usedKeys.set(base, n);
    return { key: `${base}_${n}`, sourceHeader: text, sourceIndex: index, label: text, role: text ? 'info' : 'ignore' } as BillColumn;
  });

  const assigned = new Set<number>();
  for (const rule of template?.rules ?? []) {
    const re = new RegExp(rule.match, 'i');
    let seen = 0;
    for (const col of columns) {
      if (!re.test(normalizeHeader(col.sourceHeader))) continue;
      seen++;
      if (rule.occurrence !== undefined && rule.occurrence !== seen) continue;
      if (assigned.has(col.sourceIndex)) continue;
      col.role = rule.role;
      if (rule.label) col.label = rule.label;
      assigned.add(col.sourceIndex);
    }
  }

  // Generic fallbacks for headers the template did not cover.
  if (!columns.some((c) => c.role === 'flat')) {
    const flat = columns.find((c) => /^(flat|flat no|flat number|unit|door no)$/.test(normalizeHeader(c.sourceHeader)));
    if (flat) {
      flat.role = 'flat';
      flat.label = 'Flat';
    }
  }
  if (!columns.some((c) => c.role === 'total')) {
    const candidates = columns.filter((c) => !assigned.has(c.sourceIndex) && GENERIC_TOTAL.test(normalizeHeader(c.sourceHeader)));
    // Only auto-pick when unambiguous: one candidate, or exactly one written in capitals ("TOTAL").
    const upper = candidates.filter((c) => c.sourceHeader === c.sourceHeader.toUpperCase());
    const pick = candidates.length === 1 ? candidates[0] : upper.length === 1 ? upper[0] : undefined;
    if (pick) pick.role = 'total';
  }
  return columns;
}

/** Extracts one FlatBill per data row below the header. */
export function extractFlats(rows: Row[], headerRowIndex: number, columns: BillColumn[]): FlatBill[] {
  const flatCol = columns.find((c) => c.role === 'flat');
  const totalCol = columns.find((c) => c.role === 'total');
  if (!flatCol) return [];
  const kept = columns.filter((c) => c.role !== 'ignore' && c.role !== 'flat');
  const out: FlatBill[] = [];
  for (let r = headerRowIndex + 1; r < rows.length; r++) {
    const row = rows[r] ?? [];
    const rawFlat = row[flatCol.sourceIndex];
    if (rawFlat === null || rawFlat === undefined || String(rawFlat).trim() === '') continue;
    const flat = String(rawFlat).trim().replace(/\.0+$/, '');
    if (/total|sum|grand/i.test(flat)) continue;
    const values: Record<string, CellValue> = {};
    for (const c of kept) values[c.key] = toCell(row[c.sourceIndex]);
    const total = totalCol ? toNumber(row[totalCol.sourceIndex]) : null;
    out.push({ flat, values, total: total ?? NaN, sourceRow: r + 1 });
  }
  return out;
}

export function sheetTitle(rows: Row[], headerRowIndex: number): string {
  for (let i = 0; i < Math.max(0, headerRowIndex); i++) {
    const text = (rows[i] ?? []).find((c) => typeof c === 'string' && /[a-z]{3,}/i.test(c));
    if (text) return String(text).replace(/^\*+/, '').trim();
  }
  return '';
}

export function parseSheet(rows: Row[], template?: ImportTemplate): ImportDraft {
  const headerRowIndex = detectHeaderRow(rows);
  if (headerRowIndex < 0) {
    return { headerRowIndex, title: '', detectedMonth: null, columns: [], flats: [] };
  }
  const columns = buildColumns(rows[headerRowIndex], template);
  const title = sheetTitle(rows, headerRowIndex);
  return {
    headerRowIndex,
    title,
    detectedMonth: detectMonth(title),
    columns,
    flats: extractFlats(rows, headerRowIndex, columns),
  };
}

export function sumExpenses(flat: FlatBill, columns: BillColumn[]): number {
  return columns
    .filter((c) => c.role === 'expense')
    .reduce((s, c) => s + (typeof flat.values[c.key] === 'number' ? (flat.values[c.key] as number) : 0), 0);
}

export function validateBill(
  bill: Pick<MonthBill, 'month' | 'columns' | 'flats'>,
  opts: { knownFlats?: string[]; tolerance?: number } = {},
): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const tol = opts.tolerance ?? 1;

  if (!/^20\d{2}-(0[1-9]|1[0-2])$/.test(bill.month ?? '')) errors.push('Select the month and year for this data.');
  if (!bill.columns.some((c) => c.role === 'flat')) errors.push('No column is mapped as "Flat".');
  const totals = bill.columns.filter((c) => c.role === 'total');
  if (totals.length === 0) errors.push('No column is mapped as "Total" - choose the column that holds the final amount due.');
  if (totals.length > 1) errors.push('More than one column is mapped as "Total". Keep exactly one.');
  if (bill.flats.length === 0) errors.push('No flat rows were found.');

  const seen = new Set<string>();
  const hasExpenses = bill.columns.some((c) => c.role === 'expense');
  for (const f of bill.flats) {
    if (!f.flat) errors.push(`Row ${f.sourceRow ?? '?'}: flat number is empty.`);
    if (seen.has(f.flat)) errors.push(`Flat ${f.flat} appears more than once.`);
    seen.add(f.flat);
    if (!Number.isFinite(f.total)) {
      errors.push(`Flat ${f.flat}: total is missing or not a number.`);
      continue;
    }
    if (f.total <= 0) warnings.push(`Flat ${f.flat}: total is ${f.total}.`);
    if (hasExpenses && totals.length === 1) {
      const sum = sumExpenses(f, bill.columns);
      if (Math.abs(sum - f.total) > tol) {
        warnings.push(`Flat ${f.flat}: line items add up to ${round(sum)} but total is ${f.total}.`);
      }
    }
  }

  if (opts.knownFlats?.length) {
    const known = new Set(opts.knownFlats);
    const added = [...seen].filter((f) => !known.has(f));
    const missing = opts.knownFlats.filter((f) => !seen.has(f));
    if (added.length) warnings.push(`New flats not in the previous month: ${added.join(', ')}.`);
    if (missing.length) warnings.push(`Flats from the previous month missing here: ${missing.join(', ')}.`);
  }
  return { errors, warnings };
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
