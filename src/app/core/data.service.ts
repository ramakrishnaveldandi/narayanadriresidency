import { Injectable, computed, inject, signal } from '@angular/core';
import { APP_CONFIG } from '../config/app-config';
import { compareMonthsDesc, findDuplicateRef, newId } from './billing';
import type { AuditEntry, MonthBill, MonthIndexEntry, MonthKey, MonthRecord, Payment } from './models';
import { AdminAuthService } from './admin-auth.service';

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime: string;
}

interface LocalStore {
  index?: MonthIndexEntry[];
  months: Record<MonthKey, MonthRecord>;
}

const LOCAL_KEY = 'nrpay.local.v1';

/**
 * Single entry point for reading and writing data.
 *
 * - API mode (APP_CONFIG.apiUrl set): Google Apps Script web app backed by
 *   Google Sheets. Admin requests carry a Google ID token that the backend
 *   verifies (email must be the configured admin). Public reads return only the
 *   latest month.
 * - Static mode: published months are read from /public/data/*.json (committed
 *   to the repo and served by GitHub Pages). Admin changes are kept in this
 *   browser and exported as JSON files to commit.
 */
@Injectable({ providedIn: 'root' })
export class DataService {
  private readonly auth = inject(AdminAuthService);
  private readonly cache = new Map<MonthKey, MonthRecord>();
  private indexPromise?: Promise<MonthIndexEntry[]>;

  readonly mode: 'api' | 'static' = APP_CONFIG.apiUrl ? 'api' : 'static';
  /** Every published month (newest first) that this session was given. */
  private readonly allIndex = signal<MonthIndexEntry[]>([]);
  readonly latestMonth = computed(() => this.allIndex()[0]?.month ?? null);
  /** Months the current user may see: all for the admin, only the latest for residents. */
  readonly index = computed(() => {
    const all = this.allIndex();
    return this.auth.isAdmin() || !APP_CONFIG.residentsSeeLatestMonthOnly ? all : all.slice(0, 1);
  });

  /** The month to show: the requested one if this user may see it, otherwise the latest. */
  resolveMonth(requested?: string | null): MonthKey | null {
    if (requested && this.index().some((m) => m.month === requested)) return requested;
    return this.latestMonth();
  }

  private canSee(month: MonthKey): boolean {
    return this.auth.isAdmin() || !APP_CONFIG.residentsSeeLatestMonthOnly || month === this.latestMonth();
  }
  /** Static mode: true when this browser holds admin changes not yet exported. */
  readonly hasLocalChanges = signal(this.readLocal() !== null);

  // ------------------------------------------------------------------ reads

  loadIndex(force = false): Promise<MonthIndexEntry[]> {
    if (!this.indexPromise || force) {
      this.indexPromise = this.fetchIndex().then((list) => {
        const sorted = [...list].sort((a, b) => compareMonthsDesc(a.month, b.month));
        this.allIndex.set(sorted);
        return sorted;
      });
    }
    return this.indexPromise;
  }

  async getMonth(month: MonthKey, force = false): Promise<MonthRecord | null> {
    await this.loadIndex();
    if (!this.canSee(month)) return null;
    if (!force && this.cache.has(month)) return this.cache.get(month)!;
    let record: MonthRecord | null;
    if (this.mode === 'api') {
      record = await this.apiRead<MonthRecord | null>({ action: 'month', month });
    } else {
      record = this.readLocal()?.months[month] ?? (await this.fetchJson<MonthRecord>(`${APP_CONFIG.dataPath}/${month}.json`));
    }
    if (record) {
      record.payments ??= [];
      record.audit ??= [];
      this.cache.set(month, record);
    }
    return record;
  }

  async getAllMonths(): Promise<MonthRecord[]> {
    await this.loadIndex();
    const records = await Promise.all(this.index().map((m) => this.getMonth(m.month)));
    return records.filter((r): r is MonthRecord => !!r);
  }

  // ------------------------------------------------------------- admin writes

  async publishMonth(bill: MonthBill, correctionReason?: string): Promise<void> {
    this.auth.requireAdmin();
    const existing = (await this.loadIndex()).some((m) => m.month === bill.month);
    if (existing && !correctionReason?.trim()) {
      throw new Error(`${bill.month} is already published. Enter a correction reason to replace it.`);
    }
    if (this.mode === 'api') {
      await this.apiPost({ action: 'publishMonth', bill, correctionReason });
    } else {
      const store = this.ensureLocal();
      const prev = store.months[bill.month] ?? (await this.getMonth(bill.month));
      const version = (prev?.bill.version ?? 0) + 1;
      const record: MonthRecord = {
        bill: { ...bill, version, publishedBy: this.auth.actor() },
        payments: prev?.payments ?? [],
        audit: [...(prev?.audit ?? [])],
      };
      record.audit.push(
        this.audit(existing ? 'correct-month' : 'publish', bill.month, existing ? `v${version}: ${correctionReason}` : `${bill.flats.length} flats from ${bill.source.fileName}`),
      );
      store.months[bill.month] = record;
      const index = (store.index ?? [...this.index()]).filter((m) => m.month !== bill.month);
      index.push({ month: bill.month, title: bill.title });
      store.index = index;
      this.writeLocal(store);
    }
    this.cache.delete(bill.month);
    await this.loadIndex(true);
  }

  async addPayment(input: Omit<Payment, 'id' | 'recordedAt' | 'recordedBy'>): Promise<Payment> {
    if (input.source !== 'resident') this.auth.requireAdmin();
    if (!(input.amount > 0)) throw new Error('Amount must be greater than zero.');
    const dup = await this.findDuplicate(input.txnRef);
    if (dup) throw new Error(`Reference ${input.txnRef} is already recorded for flat ${dup.flat} (${dup.month}).`);
    const payment: Payment = {
      ...input,
      txnRef: input.txnRef?.trim() || undefined,
      id: newId(),
      recordedAt: new Date().toISOString(),
      recordedBy: input.source === 'resident' ? 'resident' : this.auth.actor(),
    };
    if (this.mode === 'api') {
      await this.apiPost({ action: input.source === 'resident' ? 'submitPayment' : 'addPayment', payment });
    } else {
      await this.mutateLocal(payment.month, (r) => {
        r.payments.push(payment);
        r.audit.push(this.audit('add-payment', payment.month, `Flat ${payment.flat}: ₹${payment.amount} ref ${payment.txnRef ?? '-'} (${payment.source})`));
      });
    }
    this.cache.delete(payment.month);
    return payment;
  }

  async verifyPayment(month: MonthKey, id: string): Promise<void> {
    await this.updatePayment(month, id, { verified: true }, 'verify-payment', 'Verified');
  }

  async voidPayment(month: MonthKey, id: string, reason: string): Promise<void> {
    if (!reason.trim()) throw new Error('A reason is required to void a payment.');
    await this.updatePayment(month, id, { voided: true, voidReason: reason }, 'void-payment', reason);
  }

  private async updatePayment(month: MonthKey, id: string, patch: Partial<Payment>, action: string, reason: string): Promise<void> {
    this.auth.requireAdmin();
    if (this.mode === 'api') {
      await this.apiPost({ action: 'updatePayment', month, id, patch, reason });
    } else {
      await this.mutateLocal(month, (r) => {
        const p = r.payments.find((x) => x.id === id);
        if (!p) throw new Error('Payment not found.');
        Object.assign(p, patch);
        r.audit.push(this.audit(action, month, `Flat ${p.flat} ₹${p.amount} ref ${p.txnRef ?? '-'}: ${reason}`));
      });
    }
    this.cache.delete(month);
  }

  async findDuplicate(ref: string | undefined): Promise<Payment | undefined> {
    if (!ref?.trim()) return undefined;
    const all = await this.getAllMonths();
    return findDuplicateRef(all.flatMap((r) => r.payments), ref);
  }

  // ------------------------------------------------------------ Google Drive

  listDriveFiles(): Promise<DriveFile[]> {
    this.auth.requireAdmin();
    if (this.mode !== 'api') return Promise.reject(new Error('Google Drive import needs the Apps Script backend (apiUrl).'));
    return this.apiPost<DriveFile[]>({ action: 'listDriveFiles' });
  }

  async downloadDriveFile(id: string): Promise<{ name: string; mimeType: string; data: ArrayBuffer }> {
    this.auth.requireAdmin();
    const res = await this.apiPost<{ name: string; mimeType: string; base64: string }>({ action: 'getDriveFile', id });
    const bin = atob(res.base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return { name: res.name, mimeType: res.mimeType, data: bytes.buffer };
  }

  // ------------------------------------------------- static-mode export/reset

  /** Files to commit under public/data/ to publish static-mode changes. */
  async exportStaticFiles(): Promise<{ name: string; content: string }[]> {
    const index = await this.loadIndex(true);
    const files = [{ name: 'index.json', content: JSON.stringify({ months: index }, null, 2) + '\n' }];
    const local = this.readLocal();
    for (const month of Object.keys(local?.months ?? {})) {
      files.push({ name: `${month}.json`, content: JSON.stringify(local!.months[month], null, 2) + '\n' });
    }
    return files;
  }

  discardLocalChanges(): void {
    try {
      localStorage.removeItem(LOCAL_KEY);
    } catch {
      /* storage unavailable */
    }
    this.cache.clear();
    this.hasLocalChanges.set(false);
    void this.loadIndex(true);
  }

  // ---------------------------------------------------------------- helpers

  private audit(action: string, month: MonthKey, details: string): AuditEntry {
    return { at: new Date().toISOString(), actor: this.auth.actor(), action, month, details };
  }

  private async fetchIndex(): Promise<MonthIndexEntry[]> {
    if (this.mode === 'api') return this.apiRead<MonthIndexEntry[]>({ action: 'index' });
    const local = this.readLocal()?.index;
    if (local) return local;
    const res = await this.fetchJson<{ months: MonthIndexEntry[] }>(`${APP_CONFIG.dataPath}/index.json`);
    return res?.months ?? [];
  }

  private async fetchJson<T>(path: string): Promise<T | null> {
    const res = await fetch(path, { cache: 'no-cache' });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Could not load ${path} (${res.status})`);
    return (await res.json()) as T;
  }

  private async apiGet<T>(params: Record<string, string>): Promise<T> {
    const url = `${APP_CONFIG.apiUrl}?${new URLSearchParams(params).toString()}`;
    return this.unwrap<T>(await fetch(url));
  }

  /** Admin reads go by POST with the ID token (so the server returns all months); others by GET. */
  private apiRead<T>(params: Record<string, string>): Promise<T> {
    return this.auth.isAdmin() ? this.apiPost<T>(params) : this.apiGet<T>(params);
  }

  /** Call after sign-in / sign-out so the visible months refresh. */
  refreshForSession(): Promise<MonthIndexEntry[]> {
    this.cache.clear();
    return this.loadIndex(true);
  }

  private async apiPost<T>(body: Record<string, unknown>): Promise<T> {
    // text/plain avoids a CORS preflight, which Apps Script web apps do not answer.
    const res = await fetch(APP_CONFIG.apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ ...body, idToken: this.auth.idToken(), actor: this.auth.actor() }),
    });
    return this.unwrap<T>(res);
  }

  private async unwrap<T>(res: Response): Promise<T> {
    if (!res.ok) throw new Error(`Server error (${res.status})`);
    const json = (await res.json()) as { ok: boolean; data?: T; error?: string };
    if (!json.ok) throw new Error(json.error ?? 'Request failed');
    return json.data as T;
  }

  private async mutateLocal(month: MonthKey, fn: (r: MonthRecord) => void): Promise<void> {
    const store = this.ensureLocal();
    const record = store.months[month] ?? structuredClone(await this.getMonth(month));
    if (!record) throw new Error(`Month ${month} is not published.`);
    fn(record);
    store.months[month] = record;
    this.writeLocal(store);
  }

  private readLocal(): LocalStore | null {
    try {
      const raw = localStorage.getItem(LOCAL_KEY);
      return raw ? (JSON.parse(raw) as LocalStore) : null;
    } catch {
      return null;
    }
  }

  private ensureLocal(): LocalStore {
    return this.readLocal() ?? { months: {} };
  }

  private writeLocal(store: LocalStore): void {
    try {
      localStorage.setItem(LOCAL_KEY, JSON.stringify(store));
    } catch {
      throw new Error('Could not save in this browser (storage blocked or full).');
    }
    this.hasLocalChanges.set(true);
  }
}
