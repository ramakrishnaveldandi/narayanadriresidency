import type { FlatSummary, MonthKey, MonthRecord, MonthSummary, Payment, PaymentStatus } from './models';

/** Round to paise to avoid floating point drift. */
export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function isCounted(p: Payment): boolean {
  return p.verified && !p.voided;
}

export function derivePaymentStatus(due: number, paid: number, tolerance: number): PaymentStatus {
  const outstanding = round2(due - paid);
  if (outstanding <= tolerance) return 'Paid';
  if (paid > 0) return 'Partially Paid';
  return 'Pending';
}

export function summarizeFlat(record: MonthRecord, flat: string, tolerance: number): FlatSummary {
  const bill = record.bill.flats.find((f) => f.flat === flat);
  const due = bill?.total ?? 0;
  const mine = record.payments.filter((p) => p.flat === flat && !p.voided);
  const paid = round2(mine.filter(isCounted).reduce((s, p) => s + p.amount, 0));
  const awaitingVerification = round2(mine.filter((p) => !p.verified).reduce((s, p) => s + p.amount, 0));
  return {
    flat,
    due,
    paid,
    outstanding: round2(due - paid),
    status: derivePaymentStatus(due, paid, tolerance),
    awaitingVerification,
  };
}

export function summarizeMonth(record: MonthRecord, tolerance: number): MonthSummary {
  const flats = record.bill.flats.map((f) => summarizeFlat(record, f.flat, tolerance));
  return {
    flatCount: flats.length,
    billed: round2(flats.reduce((s, f) => s + f.due, 0)),
    collected: round2(flats.reduce((s, f) => s + f.paid, 0)),
    outstanding: round2(flats.reduce((s, f) => s + Math.max(0, f.outstanding), 0)),
    paidCount: flats.filter((f) => f.status === 'Paid').length,
    partialCount: flats.filter((f) => f.status === 'Partially Paid').length,
    pendingCount: flats.filter((f) => f.status === 'Pending').length,
  };
}

/** Normalise a transaction reference for duplicate comparison. */
export function normalizeRef(ref: string | undefined | null): string {
  return (ref ?? '').replace(/\s+/g, '').toUpperCase();
}

/** Returns the existing (non-voided) payment that already uses this reference, if any. */
export function findDuplicateRef(payments: Payment[], ref: string | undefined): Payment | undefined {
  const n = normalizeRef(ref);
  if (!n) return undefined;
  return payments.find((p) => !p.voided && normalizeRef(p.txnRef) === n);
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export function monthLabel(month: MonthKey, short = false): string {
  const [y, m] = month.split('-').map(Number);
  if (!y || !m) return month;
  const name = MONTHS[m - 1];
  return `${short ? name.slice(0, 3) : name} ${y}`;
}

export function compareMonthsDesc(a: MonthKey, b: MonthKey): number {
  return b.localeCompare(a);
}

export function newId(prefix = 'p'): string {
  const rnd = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${Date.now().toString(36)}_${rnd}`;
}
