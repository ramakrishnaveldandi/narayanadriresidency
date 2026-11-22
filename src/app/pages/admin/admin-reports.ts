import { Component, computed, inject, input, signal } from '@angular/core';
import { APP_CONFIG } from '../../config/app-config';
import { monthLabel, summarizeFlat, summarizeMonth } from '../../core/billing';
import { DataService } from '../../core/data.service';
import { downloadText, downloadWorkbook } from '../../core/spreadsheet';
import { MonthLabelPipe } from '../../shared/format';
import { MonthSelect, compareFlats } from '../../shared/month-select';

@Component({
  selector: 'app-admin-reports',
  imports: [MonthLabelPipe, MonthSelect],
  template: `
    @if (error()) {
      <div class="alert error">{{ error() }}</div>
    }
    <section class="card stack">
      <div class="row" style="align-items:flex-end">
        <h2 class="spacer">Monthly report</h2>
        <app-month-select [value]="selected()" />
      </div>
      <p class="small muted" style="margin:0">
        Excel workbook with the flat-wise bill, payments, outstanding balance and status for {{ selected() | monthLabel }}.
      </p>
      <button class="btn primary" style="align-self:flex-start" type="button" (click)="exportMonth()" [disabled]="busy() || !selected()">
        Download {{ selected() | monthLabel }} report (.xlsx)
      </button>
    </section>

    <section class="card stack">
      <h2>Backup</h2>
      <p class="small muted" style="margin:0">
        Full JSON backup of every published month, payment and audit entry. Keep a copy after each month closes.
        To restore in static mode, place the month files in <code>public/data/</code>.
      </p>
      <button class="btn" style="align-self:flex-start" type="button" (click)="backup()" [disabled]="busy()">Download full backup (.json)</button>
    </section>

    @if (data.mode === 'static') {
      <section class="card stack">
        <h2>Publish static-mode changes</h2>
        @if (data.hasLocalChanges()) {
          <div class="alert warn small">
            Changes made in this browser are not visible to residents until these files are committed to
            <code>public/data/</code> in the GitHub repository (the deploy workflow then republishes the site).
          </div>
          <div class="row">
            <button class="btn primary" type="button" (click)="exportStatic()" [disabled]="busy()">Download data files</button>
            <button class="btn danger" type="button" (click)="discard()">Discard local changes</button>
          </div>
          @if (files().length) {
            <ul class="small">
              @for (f of files(); track f) {
                <li><code>public/data/{{ f }}</code></li>
              }
            </ul>
          }
        } @else {
          <p class="muted small">No unpublished local changes.</p>
        }
      </section>
    }
  `,
})
export class AdminReports {
  readonly month = input<string>();
  protected readonly data = inject(DataService);
  protected readonly busy = signal(false);
  protected readonly error = signal('');
  protected readonly files = signal<string[]>([]);
  protected readonly selected = computed(() => this.month() || this.data.latestMonth());

  constructor() {
    void this.data.loadIndex();
  }

  async exportMonth(): Promise<void> {
    await this.run(async () => {
      const month = this.selected()!;
      const r = await this.data.getMonth(month, true);
      if (!r) throw new Error('Month not found.');
      const tol = APP_CONFIG.paidTolerance;
      const expense = r.bill.columns.filter((c) => c.role === 'expense');
      const info = r.bill.columns.filter((c) => c.role === 'info');
      const flats = [...r.bill.flats].sort((a, b) => compareFlats(a.flat, b.flat));
      const s = summarizeMonth(r, tol);
      const bill = [
        [`${APP_CONFIG.apartmentName} - ${monthLabel(month)}`],
        ['Flat', ...expense.map((c) => c.label), 'Total due', 'Paid (verified)', 'Outstanding', 'Status'],
        ...flats.map((f) => {
          const fs = summarizeFlat(r, f.flat, tol);
          return [f.flat, ...expense.map((c) => f.values[c.key]), fs.due, fs.paid, fs.outstanding, fs.status];
        }),
        [],
        ['Total billed', s.billed],
        ['Collected', s.collected],
        ['Outstanding', s.outstanding],
        ['Paid / Partial / Pending', `${s.paidCount} / ${s.partialCount} / ${s.pendingCount}`],
      ];
      const payments = [
        ['Flat', 'Paid on', 'Amount', 'Reference', 'Mode', 'Source', 'Verified', 'Voided', 'Void reason', 'Recorded by', 'Recorded at', 'Note'],
        ...r.payments.map((p) => [
          p.flat, p.paidAt, p.amount, p.txnRef ?? '', p.mode ?? '', p.source, p.verified ? 'Yes' : 'No',
          p.voided ? 'Yes' : 'No', p.voidReason ?? '', p.recordedBy ?? '', p.recordedAt, p.note ?? '',
        ]),
      ];
      const details = [['Flat', ...info.map((c) => c.label)], ...flats.map((f) => [f.flat, ...info.map((c) => f.values[c.key])])];
      await downloadWorkbook(`${APP_CONFIG.apartmentName.replace(/\s+/g, '-')}-${month}-report.xlsx`, [
        { name: 'Bill & balances', rows: bill },
        { name: 'Payments', rows: payments },
        { name: 'Meter details', rows: details },
      ]);
    });
  }

  async backup(): Promise<void> {
    await this.run(async () => {
      const months = await this.data.getAllMonths();
      const stamp = new Date().toISOString().slice(0, 10);
      downloadText(`nrpay-backup-${stamp}.json`, JSON.stringify({ exportedAt: new Date().toISOString(), months }, null, 2));
    });
  }

  async exportStatic(): Promise<void> {
    await this.run(async () => {
      const files = await this.data.exportStaticFiles();
      for (const f of files) downloadText(f.name, f.content);
      this.files.set(files.map((f) => f.name));
    });
  }

  discard(): void {
    if (confirm('Discard all admin changes stored in this browser? Export them first if you need them.')) {
      this.data.discardLocalChanges();
      this.files.set([]);
    }
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
