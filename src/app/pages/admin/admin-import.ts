import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { APP_CONFIG } from '../../config/app-config';
import { DataService, DriveFile, UploadedFile } from '../../core/data.service';
import {
  describeSheets,
  detectMonth,
  extractFlats,
  isPaidStatus,
  parseSheet,
  pickLatestSheet,
  sumExpenses,
  toNumber,
  validateBill,
  type Row,
  type SheetInfo,
} from '../../core/excel-import';
import type { BillColumn, BillSource, ColumnRole, FlatBill, MonthBill } from '../../core/models';
import { readWorkbook, type RawSheet } from '../../core/spreadsheet';
import { InrPipe, MonthLabelPipe } from '../../shared/format';

const ROLES: { value: ColumnRole; label: string }[] = [
  { value: 'flat', label: 'Flat number' },
  { value: 'expense', label: 'Expense line item' },
  { value: 'total', label: 'Total due' },
  { value: 'info', label: 'Info (shown in details)' },
  { value: 'ignore', label: 'Ignore' },
];

const EXCEL_TYPES: Record<string, string> = {
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xls: 'application/vnd.ms-excel',
  csv: 'text/csv',
};

@Component({
  selector: 'app-admin-import',
  imports: [FormsModule, RouterLink, InrPipe, MonthLabelPipe],
  template: `
    <section class="card stack">
      <h2>1. Upload the monthly Excel sheet</h2>
      <div class="row">
        <label class="btn primary">
          Choose Excel file (.xlsx)
          <input type="file" hidden accept=".xlsx,.xls,.csv" (change)="onFile($event)" />
        </label>
        @if (data.mode === 'api') {
          <button class="btn" type="button" (click)="loadDrive()" [disabled]="busy()">Pick from Google Drive</button>
        }
      </div>
      <p class="small muted" style="margin:0">
        @if (data.mode === 'api') {
          After you review and publish, the Excel file is saved to Google Drive <strong>NR Maintenance / Latest</strong> and the
          previous month's file is moved to <strong>History</strong>. Residents see the data from Drive.
        } @else {
          Google Drive is not connected yet (static mode) - the published month is kept in this browser until exported.
        }
      </p>
      @if (driveFiles().length) {
        <div class="table-wrap">
          <table>
            <thead><tr><th>Drive file</th><th>Modified</th><th></th></tr></thead>
            <tbody>
              @for (f of driveFiles(); track f.id) {
                <tr>
                  <td>{{ f.name }}</td>
                  <td class="small">{{ f.modifiedTime.slice(0, 10) }}</td>
                  <td><button class="btn sm" type="button" (click)="openDrive(f)" [disabled]="busy()">Use this file</button></td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      }
      @if (error()) {
        <div class="alert error">{{ error() }}</div>
      }
      @if (message()) {
        <div class="alert ok">{{ message() }}</div>
      }
    </section>

    @if (columns().length) {
      <section class="card stack">
        <h2>2. Month and columns</h2>
        <div class="form-grid">
          <label class="field">Month <input type="month" [ngModel]="month()" (ngModelChange)="month.set($event)" /></label>
          <label class="field" style="grid-column: span 2">Title <input [ngModel]="title()" (ngModelChange)="title.set($event)" /></label>
          @if (sheets().length > 1) {
            <label class="field">
              Sheet ({{ sheets().length }} in this workbook)
              <select (change)="selectSheet(+$any($event.target).value)">
                @for (s of sheetInfo(); track s.index) {
                  @if (s.hasHeader) {
                    <option [value]="s.index" [selected]="s.index === sheetIndex()">{{ s.name }}{{ s.month ? ' - ' + (s.month | monthLabel) : '' }}</option>
                  }
                }
              </select>
            </label>
          }
        </div>
        @if (sheets().length > 1) {
          <p class="small muted" style="margin:0">The latest month's sheet is selected automatically. Choose another sheet to import an older month.</p>
        }
        @if (titleMonth() && titleMonth() !== month()) {
          <div class="alert warn small">
            The sheet name says <strong>{{ sheetNameMonth() | monthLabel }}</strong> but the title row says
            <strong>{{ titleMonth() | monthLabel }}</strong>. Check which month this bill is for before publishing.
          </div>
        }
        @if (month() && alreadyPublished()) {
          <div class="alert warn small">
            {{ month() | monthLabel }} is already published. Publishing again replaces it as a logged correction - payments are kept.
          </div>
        }
        <details>
          <summary class="small">Column mapping (detected automatically - change only if the sheet layout changed)</summary>
          <div class="table-wrap" style="margin-top:8px">
            <table>
              <thead><tr><th>#</th><th>Header in file</th><th>Used as</th><th>Label shown to residents</th><th>Sample</th></tr></thead>
              <tbody>
                @for (c of columns(); track c.key; let i = $index) {
                  <tr [class.dim]="c.role === 'ignore'">
                    <td class="small muted">{{ c.sourceIndex + 1 }}</td>
                    <td>{{ c.sourceHeader || '(blank)' }}</td>
                    <td>
                      <select [value]="c.role" (change)="setRole(i, $any($event.target).value)">
                        @for (r of roles; track r.value) {
                          <option [value]="r.value" [selected]="r.value === c.role">{{ r.label }}</option>
                        }
                      </select>
                    </td>
                    <td><input [value]="c.label" (change)="setLabel(i, $any($event.target).value)" /></td>
                    <td class="small muted">{{ sample(c) }}</td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        </details>
      </section>

      <section class="card stack">
        <div class="row">
          <h2 class="spacer">3. Review ({{ flats().length }} flats)</h2>
          <label class="small"><input type="checkbox" [checked]="showInfo()" (change)="showInfo.set(!showInfo())" /> show meter columns</label>
          <button class="btn sm" type="button" (click)="addRow()">Add flat</button>
        </div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Flat</th>
                @for (c of gridColumns(); track c.key) {
                  <th class="num">{{ c.label }}</th>
                }
                <th class="num">Total due</th>
                <th class="num">Line-item sum</th>
                @if (hasStatus()) {
                  <th>Status</th>
                }
                <th></th>
              </tr>
            </thead>
            <tbody>
              @for (f of flats(); track $index; let i = $index) {
                <tr [class.bad]="mismatch(f)">
                  <td><input [value]="f.flat" (change)="setFlat(i, $any($event.target).value)" style="min-width:60px" /></td>
                  @for (c of gridColumns(); track c.key) {
                    <td><input class="num" [value]="f.values[c.key] ?? ''" (change)="setValue(i, c.key, $any($event.target).value)" /></td>
                  }
                  <td><input class="num" [value]="isNaN(f.total) ? '' : f.total" (change)="setTotal(i, $any($event.target).value)" /></td>
                  <td class="num small">{{ hasExpenses() ? (sum(f) | inr) : '-' }}</td>
                  @if (hasStatus()) {
                    <td>
                      @if (isPaid(f)) {
                        <span class="badge paid">{{ f.sheetStatus }} · Paid</span>
                      } @else {
                        <span class="muted small">{{ f.sheetStatus || '-' }}</span>
                      }
                    </td>
                  }
                  <td><button class="btn sm danger" type="button" (click)="removeRow(i)" aria-label="Remove row">✕</button></td>
                </tr>
              }
            </tbody>
            <tfoot>
              <tr>
                <td>Total</td>
                @for (c of gridColumns(); track c.key) {
                  <td></td>
                }
                <td class="num">{{ grandTotal() | inr }}</td>
                <td [attr.colspan]="hasStatus() ? 3 : 2"></td>
              </tr>
            </tfoot>
          </table>
        </div>
      </section>

      <section class="card stack">
        <h2>4. Confirm and publish</h2>
        @if (validation().errors.length) {
          <div class="alert error"><strong>Fix before publishing:</strong><ul>@for (e of validation().errors; track e) {<li>{{ e }}</li>}</ul></div>
        }
        @if (validation().warnings.length) {
          <div class="alert warn"><strong>Check these:</strong><ul>@for (w of validation().warnings; track w) {<li>{{ w }}</li>}</ul></div>
        }
        @if (!validation().errors.length && !validation().warnings.length) {
          <div class="alert ok">All checks passed.</div>
        }
        @if (alreadyPublished()) {
          <label class="field">Correction reason (required to replace a published month) <input [(ngModel)]="correctionReason" /></label>
        }
        @if (paidInSheet().length) {
          <label class="small">
            <input type="checkbox" [(ngModel)]="markPaidFromSheet" />
            Mark the <strong>{{ paidInSheet().length }}</strong> flats with Status "P" in the sheet as <strong>Paid</strong>
            (records a verified payment of the balance due for each).
          </label>
        }
        <label class="small"><input type="checkbox" [(ngModel)]="reviewed" /> I have checked the figures against the Excel sheet.</label>
        <div class="row">
          <button class="btn primary" type="button" (click)="publish()" [disabled]="busy() || validation().errors.length > 0 || !reviewed">
            {{ busy() ? 'Publishing…' : 'Publish ' + (month() | monthLabel) }}
          </button>
          <button class="btn" type="button" (click)="reset()">Discard</button>
          @if (published()) {
            <a routerLink="/" [queryParams]="{ month: published() }">View on dashboard →</a>
          }
        </div>
      </section>
    }
  `,
  styles: `
    tr.dim td { opacity: 0.55; }
    tr.bad td { background: var(--bad-soft); }
  `,
})
export class AdminImport {
  protected readonly data = inject(DataService);
  protected readonly roles = ROLES;

  protected readonly busy = signal(false);
  protected readonly error = signal('');
  protected readonly message = signal('');
  protected readonly published = signal<string | null>(null);
  protected readonly driveFiles = signal<DriveFile[]>([]);

  protected readonly source = signal<BillSource | null>(null);
  protected readonly sheets = signal<RawSheet[]>([]);
  protected readonly sheetIndex = signal(0);
  protected readonly headerRow = signal(-1);
  /** The uploaded Excel file - saved to Drive (Latest/) when the month is published. */
  private upload: UploadedFile | null = null;

  protected readonly month = signal('');
  protected readonly title = signal('');
  protected readonly columns = signal<BillColumn[]>([]);
  protected readonly flats = signal<FlatBill[]>([]);
  protected readonly showInfo = signal(false);
  protected readonly sheetInfo = signal<SheetInfo[]>([]);
  protected readonly sheetNameMonth = signal<string | null>(null);
  protected readonly titleMonth = signal<string | null>(null);
  protected markPaidFromSheet = true;
  protected correctionReason = '';
  protected reviewed = false;
  protected readonly isNaN = Number.isNaN;

  protected readonly alreadyPublished = computed(() => this.data.index().some((m) => m.month === this.month()));
  protected readonly hasExpenses = computed(() => this.columns().some((c) => c.role === 'expense'));
  protected readonly hasStatus = computed(() => this.columns().some((c) => c.role === 'status'));
  protected readonly paidInSheet = computed(() => this.flats().filter((f) => isPaidStatus(f.sheetStatus)).map((f) => f.flat));
  protected readonly gridColumns = computed(() =>
    this.columns().filter((c) => c.role === 'expense' || (this.showInfo() && c.role === 'info')),
  );
  protected readonly grandTotal = computed(() => this.flats().reduce((s, f) => s + (Number.isFinite(f.total) ? f.total : 0), 0));
  private readonly knownFlats = signal<string[]>([]);
  protected readonly validation = computed(() =>
    validateBill(
      { month: this.month(), columns: this.columns(), flats: this.flats() },
      { knownFlats: this.knownFlats(), tolerance: APP_CONFIG.paidTolerance },
    ),
  );

  constructor() {
    void this.data.loadIndex();
  }

  // ------------------------------------------------------------- loading

  async onFile(ev: Event): Promise<void> {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    await this.load(file.name, file.type, await file.arrayBuffer(), 'excel');
  }

  async loadDrive(): Promise<void> {
    await this.run(async () => this.driveFiles.set(await this.data.listDriveFiles()));
  }

  async openDrive(f: DriveFile): Promise<void> {
    await this.run(async () => {
      const file = await this.data.downloadDriveFile(f.id);
      await this.load(file.name, file.mimeType, file.data, 'drive', f.id);
    });
  }

  private async load(name: string, mime: string, data: ArrayBuffer, kind: 'excel' | 'drive', driveFileId?: string): Promise<void> {
    this.reset();
    const ext = name.toLowerCase().split('.').pop() ?? '';
    if (!EXCEL_TYPES[ext] && !/spreadsheet|excel|csv/i.test(mime)) {
      this.error.set('Please upload the Excel sheet (.xlsx, .xls or .csv).');
      return;
    }
    // Drive files are moved inside Drive by the backend; only fresh uploads need sending.
    this.upload = kind === 'drive' ? null : { name, mimeType: EXCEL_TYPES[ext] ?? mime, data };
    await this.loadKnownFlats();
    await this.run(async () => {
      const sheets = await readWorkbook(data);
      this.sheets.set(sheets);
      this.source.set({ fileName: name, kind, driveFileId, importedAt: new Date().toISOString() });
      const info = describeSheets(sheets);
      this.sheetInfo.set(info);
      this.selectSheet(pickLatestSheet(info));
      if (!this.columns().length) this.error.set('Could not find a header row with a "Flat" column in this file.');
    });
  }

  selectSheet(i: number): void {
    const sheet = this.sheets()[i];
    if (!sheet) return;
    this.sheetIndex.set(i);
    const draft = parseSheet(sheet.rows, APP_CONFIG.importTemplate);
    this.headerRow.set(draft.headerRowIndex);
    this.columns.set(draft.columns);
    this.flats.set(draft.flats);
    const src = this.source();
    if (src) this.source.set({ ...src, sheetName: sheet.name });
    // Month: sheet name first (e.g. "OCT 2026"), then the title row, then the file name.
    this.sheetNameMonth.set(detectMonth(sheet.name));
    this.titleMonth.set(draft.detectedMonth);
    this.month.set(this.sheetNameMonth() ?? draft.detectedMonth ?? detectMonth(src?.fileName ?? '') ?? '');
    this.title.set(draft.title || '');
    this.defaultTitle();
  }

  // ------------------------------------------------------------- editing

  setRole(i: number, role: ColumnRole): void {
    this.columns.update((cols) => cols.map((c, j) => (j === i ? { ...c, role } : c)));
    this.reextract();
  }

  setLabel(i: number, label: string): void {
    this.columns.update((cols) => cols.map((c, j) => (j === i ? { ...c, label } : c)));
  }

  setFlat(i: number, flat: string): void {
    this.patchRow(i, (f) => ({ ...f, flat: flat.trim() }));
  }

  setValue(i: number, key: string, raw: string): void {
    const n = toNumber(raw);
    this.patchRow(i, (f) => ({ ...f, values: { ...f.values, [key]: raw.trim() === '' ? null : (n ?? raw.trim()) } }));
  }

  setTotal(i: number, raw: string): void {
    this.patchRow(i, (f) => ({ ...f, total: toNumber(raw) ?? NaN }));
  }

  addRow(): void {
    this.flats.update((list) => [...list, { flat: '', values: {}, total: NaN }]);
  }

  removeRow(i: number): void {
    this.flats.update((list) => list.filter((_, j) => j !== i));
  }

  protected isPaid(f: FlatBill): boolean {
    return isPaidStatus(f.sheetStatus);
  }

  protected sum(f: FlatBill): number {
    return sumExpenses(f, this.columns());
  }

  protected mismatch(f: FlatBill): boolean {
    return !Number.isFinite(f.total) || (this.hasExpenses() && Math.abs(this.sum(f) - f.total) > APP_CONFIG.paidTolerance);
  }

  protected sample(c: BillColumn): string {
    const rows = this.sheets()[this.sheetIndex()]?.rows;
    const v = rows?.[this.headerRow() + 1]?.[c.sourceIndex];
    return v === null || v === undefined ? '' : String(v).slice(0, 18);
  }

  // ------------------------------------------------------------- publish

  async publish(): Promise<void> {
    const src = this.source();
    if (!src) return;
    const bill: MonthBill = {
      month: this.month(),
      title: this.title() || `${APP_CONFIG.apartmentName} maintenance`,
      columns: this.columns(),
      flats: this.flats(),
      source: src,
      publishedAt: new Date().toISOString(),
      version: 1,
    };
    await this.run(async () => {
      const markPaid = this.markPaidFromSheet ? this.paidInSheet() : [];
      await this.data.publishMonth(bill, this.alreadyPublished() ? this.correctionReason : undefined, this.upload ?? undefined, markPaid);
      this.published.set(bill.month);
      const extra =
        this.data.mode === 'static'
          ? ' Export the data files from Reports & backup to make it visible to residents.'
          : ' The Excel file is saved in Google Drive (NR Maintenance / Latest), last month moved to History, and residents now see this month.';
      const paidNote = markPaid.length ? ` ${markPaid.length} flats marked Paid from the Status column.` : '';
      this.message.set(`Published ${bill.month} with ${bill.flats.length} flats.${paidNote}${extra}`);
    });
  }

  reset(): void {
    this.sheets.set([]);
    this.columns.set([]);
    this.flats.set([]);
    this.source.set(null);
    this.month.set('');
    this.title.set('');
    this.error.set('');
    this.message.set('');
    this.published.set(null);
    this.correctionReason = '';
    this.reviewed = false;
    this.upload = null;
    this.sheetInfo.set([]);
    this.sheetNameMonth.set(null);
    this.titleMonth.set(null);
    this.markPaidFromSheet = true;
  }

  // ------------------------------------------------------------- helpers

  private reextract(): void {
    const rows: Row[] | undefined = this.sheets()[this.sheetIndex()]?.rows;
    if (rows && this.headerRow() >= 0) this.flats.set(extractFlats(rows, this.headerRow(), this.columns()));
  }

  private patchRow(i: number, fn: (f: FlatBill) => FlatBill): void {
    this.flats.update((list) => list.map((f, j) => (j === i ? fn(f) : f)));
  }

  private defaultTitle(): void {
    if (this.month() && !/\d{4}|\b\d{2}\b/.test(this.title())) {
      const [y, m] = this.month().split('-');
      const name = new Date(Number(y), Number(m) - 1, 1).toLocaleString('en-IN', { month: 'long' });
      this.title.set(`${APP_CONFIG.apartmentName} - ${name} ${y} Maintenance`);
    }
  }

  private async loadKnownFlats(): Promise<void> {
    const latest = (await this.data.loadIndex())[0];
    const rec = latest ? await this.data.getMonth(latest.month) : null;
    this.knownFlats.set(rec?.bill.flats.map((f) => f.flat) ?? []);
  }

  private async run(fn: () => Promise<void>): Promise<void> {
    this.busy.set(true);
    this.error.set('');
    try {
      await fn();
    } catch (e) {
      this.error.set((e as Error).message);
    } finally {
      this.busy.set(false);
    }
  }
}
