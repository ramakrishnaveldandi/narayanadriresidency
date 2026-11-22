/** Month key in ISO form, e.g. "2026-10". */
export type MonthKey = string;

export type ColumnRole = 'flat' | 'info' | 'expense' | 'total' | 'status' | 'ignore';

export interface BillColumn {
  /** Stable key, unique within a month (headers can repeat, e.g. three "Total" columns). */
  key: string;
  /** Header text exactly as it appeared in the source file. */
  sourceHeader: string;
  /** Zero-based column index in the source sheet (for traceability). */
  sourceIndex: number;
  /** Display label shown to residents. */
  label: string;
  role: ColumnRole;
}

export type CellValue = number | string | null;

export interface FlatBill {
  flat: string;
  /** Values keyed by BillColumn.key (only non-ignored columns). */
  values: Record<string, CellValue>;
  /** Total due for the month, taken from the mapped total column. */
  total: number;
  /** 1-based row number in the source sheet (for traceability). */
  sourceRow?: number;
  /** Value of the sheet's "Status" column, e.g. "P" (paid). */
  sheetStatus?: string;
}

export interface BillSource {
  fileName: string;
  sheetName?: string;
  kind: 'excel' | 'drive';
  driveFileId?: string;
  importedAt: string;
}

export interface MonthBill {
  month: MonthKey;
  title: string;
  columns: BillColumn[];
  flats: FlatBill[];
  source: BillSource;
  publishedAt: string;
  publishedBy?: string;
  /** Incremented on every correction after the first publish. */
  version: number;
}

export type PaymentSource = 'admin' | 'resident' | 'reconciliation' | 'sheet';

export interface Payment {
  id: string;
  month: MonthKey;
  flat: string;
  amount: number;
  /** When the resident paid (ISO date or date-time). */
  paidAt: string;
  /** UPI UTR / bank reference. Used for duplicate detection. */
  txnRef?: string;
  mode?: string;
  source: PaymentSource;
  /** Only verified payments reduce the outstanding balance. */
  verified: boolean;
  note?: string;
  recordedAt: string;
  recordedBy?: string;
  voided?: boolean;
  voidReason?: string;
}

export interface AuditEntry {
  at: string;
  actor: string;
  action: string;
  month?: MonthKey;
  details: string;
}

/** Everything the app knows about one month. */
export interface MonthRecord {
  bill: MonthBill;
  payments: Payment[];
  audit: AuditEntry[];
}

export interface MonthIndexEntry {
  month: MonthKey;
  title: string;
}

export type PaymentStatus = 'Paid' | 'Partially Paid' | 'Pending';

export interface FlatSummary {
  flat: string;
  due: number;
  paid: number;
  outstanding: number;
  status: PaymentStatus;
  /** Sum of resident-submitted payments that an admin has not verified yet. */
  awaitingVerification: number;
}

export interface MonthSummary {
  flatCount: number;
  billed: number;
  collected: number;
  outstanding: number;
  paidCount: number;
  partialCount: number;
  pendingCount: number;
}
