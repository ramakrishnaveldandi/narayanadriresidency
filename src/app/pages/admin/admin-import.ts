import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { APP_CONFIG } from '../../config/app-config';
import { DataService, DriveFile, UploadedFile } from '../../core/data.service';
import { detectMonth, extractFlats, parseSheet, sumExpenses, toNumber, validateBill, type Row } from '../../core/excel-import';
import type { BillColumn, BillSource, ColumnRole, FlatBill, MonthBill } from '../../core/models';
import { readWorkbook, type RawSheet } from '../../core/spreadsheet';
import { toSheetRows, type ReadRow } from '../../core/ocr-table';
import { InrPipe, MonthLabelPipe } from '../../shared/format';

const ROLES: { value: ColumnRole; label: string }[] = [
  { value: 'flat', label: 'Flat number' },
  { value: 'expense', label: 'Expense line item' },
  { value: 'total', label: 'Total due' },
  { value: 'info', label: 'Info (shown in details)' },
  { value: 'ignore', label: 'Ignore' },
];

@Component({
  selector: 'app-admin-import',
  imports: [FormsModule, RouterLink, InrPipe, MonthLabelPipe],
  template: `
    <section class="card stack">
      <h2>1. Choose the monthly file</h2>
      <div class="row">
        <label class="btn primary">
          Upload Excel / CSV / image
          <input type="file" hidden accept=".xlsx,.xls,.csv,image/*" (change)="onFile($event)" />
        </label>
        @if (data.mode === 'api') {
          <button class="btn" type="button" (click)="loadDrive()" [disabled]="busy()">Browse Google Drive folder</button>
          <span class="small muted">On publish the file is saved to Drive: NR Maintenance / Latest (previous month → History).</span>
        } @else {
          <span class="small muted">Google Drive import is available once the Apps Script backend is connected.</span>
        }
      </div>
      @if (driveFiles().length) {
        <div class="table-wrap">
          <table>
            <thead><tr><th>Drive file</th><th>Modified</th><th></th></tr></thead>
            <tbody>
              @for (f of driveFiles(); track f.id) {
                <tr>
                  <td>{{ f.name }}</td>
                  <td class="small">{{ f.modifiedTime.slice(0, 10) }}</td>
                  <td><button class="btn sm" type="button" (click)="openDrive(f)" [disabled]="busy()">Import</button></td>
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

    @if (imageUrl()) {
      <section class="card stack">
        <h2>Uploaded image</h2>
        @if (ocrProgress(); as p) {
          <div class="alert info small">
            {{ p.message }}
            <div class="bar"><div [style.width.%]="p.fraction * 100"></div></div>
          </div>
        }
        @if (ocrSummary(); as sum) {
          <div class="alert small" [class.ok]="sum.check === 0" [class.warn]="sum.check > 0">
            Read <strong>{{ sum.read }}</strong> flats from the image.
            <strong>{{ sum.ok }}</strong> confirmed (meter readings × tariff match the TOTAL).
            @if (sum.check > 0) {
              <strong>{{ sum.check }}</strong> highlighted below - please check those rows against the image.
            }
          </div>
        }
        <details [open]="!columns().length">
          <summary class="small">Show image</summary>
          <img [src]="imageUrl()" alt="Uploaded maintenance sheet" class="ref-img" style="margin-top:8px" />
        </details>
        @if (!ocrProgress()) {
          <div class="row">
            <button class="btn sm" type="button" (click)="rerunOcr()" [disabled]="busy()">Read image again</button>
            <button class="btn sm" type="button" (click)="startFromPrevious()" [disabled]="!data.latestMonth()">Enter manually instead</button>
          </div>
        }
      </section>
    }

    @if (columns().length) {
      <section class="card stack">
        <h2>2. Month and column mapping</h2>
        <div class="form-grid">
          <label class="field">Month <input type="month" [ngModel]="month()" (ngModelChange)="month.set($event)" /></label>
          <label class="field" style="grid-column: span 2">Title <input [ngModel]="title()" (ngModelChange)="title.set($event)" /></label>
          @if (sheets().length > 1) {
            <label class="field">
              Sheet
              <select (change)="selectSheet(+$any($event.target).value)">
                @for (s of sheets(); track s.name; let i = $index) {
                  <option [value]="i" [selected]="i === sheetIndex()">{{ s.name }}</option>
                }
              </select>
            </label>
          }
        </div>
        @if (month() && alreadyPublished()) {
          <div class="alert warn small">
            {{ month() | monthLabel }} is already published. Publishing again replaces it as a logged correction - payments are kept.
          </div>
        }
        <p class="small muted">
          Pick exactly one <strong>Total due</strong> column. Expense line items are shown to residents as the bill breakdown and
          should add up to the total.
        </p>
        <div class="table-wrap">
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
      </section>

      <section class="card stack">
        <div class="row">
          <h2 class="spacer">3. Review and correct ({{ flats().length }} flats)</h2>
          <label class="small"><input type="checkbox" [checked]="showInfo()" (change)="showInfo.set(!showInfo())" /> show info columns</label>
          <button class="btn sm" type="button" (click)="fillTotals()">Total = sum of line items (empty totals)</button>
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
                @if (ocrStatus().size) {
                  <th>Image check</th>
                }
                <th></th>
              </tr>
            </thead>
            <tbody>
              @for (f of flats(); track $index; let i = $index) {
                <tr [class.bad]="mismatch(f) || ocrStatus().get(f.flat)?.status === 'missing'" [class.check]="ocrStatus().get(f.flat)?.status === 'check'">
                  <td><input [value]="f.flat" (change)="setFlat(i, $any($event.target).value)" style="min-width:60px" /></td>
                  @for (c of gridColumns(); track c.key) {
                    <td><input class="num" [value]="f.values[c.key] ?? ''" (change)="setValue(i, c.key, $any($event.target).value)" /></td>
                  }
                  <td><input class="num" [value]="isNaN(f.total) ? '' : f.total" (change)="setTotal(i, $any($event.target).value)" /></td>
                  <td class="num small">{{ hasExpenses() ? (sum(f) | inr) : '-' }}</td>
                  @if (ocrStatus().size) {
                    <td class="small">
                      @switch (ocrStatus().get(f.flat)?.status) {
                        @case ('ok') { <span class="badge paid">✓ Confirmed</span> }
                        @case ('check') { <span class="badge partially-paid" [title]="ocrStatus().get(f.flat)!.notes.join(' ')">Check</span> <span class="muted">{{ ocrStatus().get(f.flat)!.notes.join(' ') }}</span> }
                        @case ('missing') { <span class="badge pending">Not read</span> <span class="muted">{{ ocrStatus().get(f.flat)!.notes.join(' ') }}</span> }
                        @default { <span class="muted">edited</span> }
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
                <td [attr.colspan]="ocrStatus().size ? 3 : 2"></td>
              </tr>
            </tfoot>
          </table>
        </div>
      </section>

      <section class="card stack">
        <h2>4. Validate and publish</h2>
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
        <label class="small"><input type="checkbox" [(ngModel)]="reviewed" /> I have reviewed the figures against the source{{ source()?.kind === 'image-manual' ? ' image' : ' file' }}.</label>
        <div class="row">
          <button class="btn primary" type="button" (click)="publish()" [disabled]="busy() || validation().errors.length > 0 || !reviewed">
            Publish {{ month() | monthLabel }}
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
    .ref-img { max-width: 100%; border: 1px solid var(--border); border-radius: 8px; }
    tr.dim td { opacity: 0.55; }
    tr.bad td { background: var(--bad-soft); }
    tr.check td { background: var(--warn-soft); }
    .bar { height: 6px; background: var(--surface); border-radius: 3px; margin-top: 6px; overflow: hidden; }
    .bar div { height: 100%; background: var(--primary); transition: width 0.3s; }
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
  protected readonly imageUrl = signal<string | null>(null);
  protected readonly ocrProgress = signal<{ message: string; fraction: number } | null>(null);
  protected readonly ocrStatus = signal<Map<string, Pick<ReadRow, 'status' | 'notes'>>>(new Map());
  protected readonly ocrSummary = computed(() => {
    const st = [...this.ocrStatus().values()];
    if (!st.length) return null;
    const ok = st.filter((x) => x.status === 'ok').length;
    return { read: st.filter((x) => x.status !== 'missing').length, ok, check: st.length - ok };
  });
  private imageData: { name: string; mime: string; data: ArrayBuffer } | null = null;
  /** The uploaded file itself - stored in Drive (Latest/) when the month is published. */
  private upload: UploadedFile | null = null;

  protected readonly month = signal('');
  protected readonly title = signal('');
  protected readonly columns = signal<BillColumn[]>([]);
  protected readonly flats = signal<FlatBill[]>([]);
  protected readonly showInfo = signal(false);
  protected correctionReason = '';
  protected reviewed = false;
  protected readonly isNaN = Number.isNaN;

  protected readonly alreadyPublished = computed(() => this.data.index().some((m) => m.month === this.month()));
  protected readonly hasExpenses = computed(() => this.columns().some((c) => c.role === 'expense'));
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
    // Drive files are moved inside Drive by the backend; only fresh uploads need sending.
    this.upload = kind === 'drive' ? null : { name, mimeType: mime || guessMime(name), data };
    await this.loadKnownFlats();
    if (mime.startsWith('image/') || /\.(png|jpe?g|webp|gif)$/i.test(name)) {
      this.imageUrl.set(URL.createObjectURL(new Blob([data], { type: mime || 'image/jpeg' })));
      this.source.set({ fileName: name, kind: 'image-ocr', driveFileId, importedAt: new Date().toISOString() });
      this.month.set(detectMonth(name) ?? '');
      this.imageData = { name, mime, data };
      await this.readImage();
      return;
    }
    await this.run(async () => {
      const sheets = await readWorkbook(data);
      this.sheets.set(sheets);
      this.source.set({ fileName: name, kind, driveFileId, importedAt: new Date().toISOString() });
      const first = Math.max(0, sheets.findIndex((s) => parseSheet(s.rows).headerRowIndex >= 0));
      this.selectSheet(first);
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
    const month = draft.detectedMonth ?? detectMonth(src?.fileName ?? '', sheet.name) ?? '';
    this.month.set(month);
    this.title.set(draft.title || '');
    this.defaultTitle();
  }

  async rerunOcr(): Promise<void> {
    await this.readImage();
  }

  /** Reads the uploaded screenshot into the review grid (see core/ocr-table.ts). */
  private async readImage(): Promise<void> {
    const img = this.imageData;
    if (!img) return;
    this.error.set('');
    this.busy.set(true);
    this.ocrProgress.set({ message: 'Starting…', fraction: 0 });
    try {
      const prev = await this.previousBill();
      const { readSheetImage } = await import('../../core/ocr-reader');
      const res = await readSheetImage(
        img.data,
        img.mime,
        { tariff: APP_CONFIG.waterTariff, fixed: prev.fixed, knownFlats: prev.flats, fileName: img.name },
        (message, fraction) => this.ocrProgress.set({ message, fraction }),
      );
      const title = res.title || `${APP_CONFIG.apartmentName} maintenance`;
      this.sheets.set([{ name: 'Image', rows: toSheetRows(res.rows, res.tariff, APP_CONFIG.sheetHeader, title) }]);
      this.selectSheet(0);
      if (res.month) this.month.set(res.month);
      this.defaultTitle();
      this.ocrStatus.set(new Map(res.rows.map((r) => [r.flat, { status: r.status, notes: r.notes }])));
    } catch (e) {
      this.error.set(`Could not read the image automatically: ${(e as Error).message} You can use "Enter manually instead".`);
    } finally {
      this.ocrProgress.set(null);
      this.busy.set(false);
    }
  }

  /** Previous month's flats (in sheet order) and its fixed charges, to guide the image reader. */
  private async previousBill(): Promise<{ flats: string[]; fixed: { manjeera: number; maintenance: number } }> {
    const latest = this.data.latestMonth();
    const rec = latest ? await this.data.getMonth(latest) : null;
    const fixed = { ...APP_CONFIG.fixedCharges };
    if (!rec) return { flats: [], fixed };
    const flats = [...rec.bill.flats].sort((a, b) => (a.sourceRow ?? 0) - (b.sourceRow ?? 0)).map((f) => f.flat);
    const mode = (re: RegExp): number | undefined => {
      const col = rec.bill.columns.find((c) => re.test(c.sourceHeader.toLowerCase()));
      if (!col) return undefined;
      const counts = new Map<number, number>();
      for (const f of rec.bill.flats) {
        const v = f.values[col.key];
        if (typeof v === 'number') counts.set(v, (counts.get(v) ?? 0) + 1);
      }
      return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    };
    fixed.manjeera = mode(/^manjeera/) ?? fixed.manjeera;
    fixed.maintenance = mode(/^(mnts|maint)/) ?? fixed.maintenance;
    return { flats, fixed };
  }

  startFromPrevious(): void {
    this.ocrStatus.set(new Map());
    const src = this.source();
    if (src) this.source.set({ ...src, kind: 'image-manual' });
    void this.run(async () => {
      const prev = await this.data.getMonth(this.data.latestMonth()!);
      if (!prev) return;
      this.columns.set(prev.bill.columns.map((c) => ({ ...c })));
      const keep = prev.bill.columns.filter((c) => c.role !== 'ignore' && c.role !== 'flat');
      this.flats.set(
        prev.bill.flats.map((f) => ({
          flat: f.flat,
          // Fixed charges (same for every flat last month) are carried over; the rest are left blank.
          values: Object.fromEntries(keep.map((c) => [c.key, this.isFixed(prev.bill.flats, c.key) ? f.values[c.key] : null])),
          total: NaN,
        })),
      );
      this.defaultTitle();
    });
  }

  // ------------------------------------------------------------- editing

  setRole(i: number, role: ColumnRole): void {
    this.columns.update((cols) => cols.map((c, j) => (j === i ? { ...c, role } : c)));
    this.reextract();
  }

  setLabel(i: number, label: string): void {
    this.columns.update((cols) => cols.map((c, j) => (j === i ? { ...c, label } : c)));
  }

  private markEdited(i: number): void {
    const flat = this.flats()[i]?.flat;
    if (!flat || !this.ocrStatus().has(flat)) return;
    const m = new Map(this.ocrStatus());
    m.delete(flat);
    this.ocrStatus.set(m);
  }

  setFlat(i: number, flat: string): void {
    this.markEdited(i);
    this.patchRow(i, (f) => ({ ...f, flat: flat.trim() }));
  }

  setValue(i: number, key: string, raw: string): void {
    this.markEdited(i);
    const n = toNumber(raw);
    this.patchRow(i, (f) => ({ ...f, values: { ...f.values, [key]: raw.trim() === '' ? null : (n ?? raw.trim()) } }));
  }

  setTotal(i: number, raw: string): void {
    this.markEdited(i);
    this.patchRow(i, (f) => ({ ...f, total: toNumber(raw) ?? NaN }));
  }

  addRow(): void {
    this.flats.update((list) => [...list, { flat: '', values: {}, total: NaN }]);
  }

  removeRow(i: number): void {
    this.flats.update((list) => list.filter((_, j) => j !== i));
  }

  fillTotals(): void {
    const cols = this.columns();
    this.flats.update((list) => list.map((f) => (Number.isFinite(f.total) ? f : { ...f, total: Math.round(sumExpenses(f, cols) * 100) / 100 })));
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
      await this.data.publishMonth(bill, this.alreadyPublished() ? this.correctionReason : undefined, this.upload ?? undefined);
      this.published.set(bill.month);
      const extra =
        this.data.mode === 'static'
          ? ' Export the data files from Reports & backup to make it visible to residents.'
          : ' The source file is saved in Google Drive (NR Maintenance / Latest) and the previous month moved to History.';
      this.message.set(`Published ${bill.month} with ${bill.flats.length} flats.${extra}`);
    });
  }

  reset(): void {
    const url = this.imageUrl();
    if (url) URL.revokeObjectURL(url);
    this.imageUrl.set(null);
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
    this.imageData = null;
    this.ocrStatus.set(new Map());
    this.ocrProgress.set(null);
  }

  // ------------------------------------------------------------- helpers

  private reextract(): void {
    const rows: Row[] | undefined = this.sheets()[this.sheetIndex()]?.rows;
    if (rows && this.headerRow() >= 0) this.flats.set(extractFlats(rows, this.headerRow(), this.columns()));
  }

  private patchRow(i: number, fn: (f: FlatBill) => FlatBill): void {
    this.flats.update((list) => list.map((f, j) => (j === i ? fn(f) : f)));
  }

  private isFixed(flats: FlatBill[], key: string): boolean {
    const vals = new Set(flats.map((f) => f.values[key]));
    return vals.size === 1 && typeof flats[0]?.values[key] === 'number';
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

function guessMime(name: string): string {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  const map: Record<string, string> = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', xls: 'application/vnd.ms-excel', csv: 'text/csv',
  };
  return map[ext] ?? 'application/octet-stream';
}
