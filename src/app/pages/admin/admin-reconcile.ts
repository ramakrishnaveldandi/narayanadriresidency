import { Component, computed, inject, input, resource, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { normalizeRef, round2 } from '../../core/billing';
import { DataService } from '../../core/data.service';
import { normalizeHeader, toNumber, type Row } from '../../core/excel-import';
import type { Payment } from '../../core/models';
import { readWorkbook } from '../../core/spreadsheet';
import { InrPipe, MonthLabelPipe } from '../../shared/format';
import { MonthSelect } from '../../shared/month-select';

interface StatementLine {
  index: number;
  date: string;
  amount: number;
  ref: string;
  narration: string;
  /** Suggested flat found in the narration. */
  flat: string;
  /** Payment already in the ledger with this reference. */
  existing?: Payment;
  done?: string;
}

type Field = 'date' | 'amount' | 'ref' | 'narration';

@Component({
  selector: 'app-admin-reconcile',
  imports: [FormsModule, InrPipe, MonthLabelPipe, MonthSelect],
  template: `
    <div class="row" style="align-items:flex-end;margin-bottom:12px">
      <h2 class="spacer">Reconcile with bank / UPI statement</h2>
      <app-month-select [value]="selected()" />
    </div>
    <section class="card stack">
      <p class="small muted" style="margin:0">
        Upload the association account statement (Excel or CSV export from the bank or UPI app). Credits are matched to flats by
        UTR / reference or by a flat number in the narration. Nothing is recorded until you confirm each line.
      </p>
      <label class="btn primary" style="align-self:flex-start">
        Upload statement
        <input type="file" hidden accept=".xlsx,.xls,.csv" (change)="onFile($event)" />
      </label>
      @if (error()) {
        <div class="alert error">{{ error() }}</div>
      }
      @if (headers().length) {
        <div class="form-grid">
          @for (f of fields; track f.key) {
            <label class="field">
              {{ f.label }}
              <select (change)="setMap(f.key, +$any($event.target).value)">
                <option value="-1">-</option>
                @for (h of headers(); track $index; let i = $index) {
                  <option [value]="i" [selected]="map()[f.key] === i">{{ h || 'Column ' + (i + 1) }}</option>
                }
              </select>
            </label>
          }
        </div>
      }
    </section>

    @if (lines().length) {
      <section class="card stack">
        <h3>Credits ({{ lines().length }}) → {{ selected() | monthLabel }}</h3>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Date</th><th>Reference</th><th>Narration</th><th class="num">Amount</th><th>Flat</th><th></th></tr></thead>
            <tbody>
              @for (l of lines(); track l.index) {
                <tr>
                  <td class="small">{{ l.date }}</td>
                  <td class="small">{{ l.ref || '-' }}</td>
                  <td class="small">{{ l.narration }}</td>
                  <td class="num">{{ l.amount | inr }}</td>
                  <td>
                    <select [value]="l.flat" (change)="setFlat(l, $any($event.target).value)" [disabled]="!!l.existing?.verified || !!l.done">
                      <option value="">-</option>
                      @for (f of flats(); track f) {
                        <option [value]="f" [selected]="f === l.flat">{{ f }}</option>
                      }
                    </select>
                  </td>
                  <td>
                    @if (l.done) {
                      <span class="badge paid">{{ l.done }}</span>
                    } @else if (l.existing?.verified) {
                      <span class="badge paid">Already recorded ({{ l.existing!.flat }})</span>
                    } @else if (l.existing) {
                      <button class="btn sm primary" type="button" (click)="verifyExisting(l)" [disabled]="busy()">Verify submission ({{ l.existing.flat }})</button>
                    } @else {
                      <button class="btn sm primary" type="button" (click)="recordLine(l)" [disabled]="busy() || !l.flat">Record</button>
                    }
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      </section>
    }
  `,
})
export class AdminReconcile {
  readonly month = input<string>();
  private readonly data = inject(DataService);
  protected readonly busy = signal(false);
  protected readonly error = signal('');

  protected readonly fields: { key: Field; label: string }[] = [
    { key: 'date', label: 'Date column' },
    { key: 'amount', label: 'Credit amount column' },
    { key: 'ref', label: 'UTR / reference column' },
    { key: 'narration', label: 'Narration / description column' },
  ];

  protected readonly selected = computed(() => this.month() || this.data.latestMonth());
  protected readonly record = resource({
    params: () => this.selected() ?? undefined,
    loader: ({ params }) => this.data.getMonth(params, true),
  });
  private readonly allPayments = resource({
    params: () => this.record.value(),
    loader: async () => (await this.data.getAllMonths()).flatMap((r) => r.payments),
  });
  protected readonly flats = computed(() => this.record.value()?.bill.flats.map((f) => f.flat) ?? []);

  private readonly rows = signal<Row[]>([]);
  private readonly headerIndex = signal(-1);
  protected readonly headers = computed(() => (this.rows()[this.headerIndex()] ?? []).map((h) => String(h ?? '')));
  protected readonly map = signal<Record<Field, number>>({ date: -1, amount: -1, ref: -1, narration: -1 });
  private readonly overrides = signal<Record<number, Partial<StatementLine>>>({});

  protected readonly lines = computed<StatementLine[]>(() => {
    const m = this.map();
    if (m.amount < 0) return [];
    const flats = this.flats();
    const payments = (this.allPayments.value() ?? []).filter((p) => !p.voided);
    const out: StatementLine[] = [];
    this.rows().forEach((row, index) => {
      if (index <= this.headerIndex()) return;
      const amount = toNumber(row[m.amount]);
      if (amount === null || amount <= 0) return;
      const narration = m.narration >= 0 ? String(row[m.narration] ?? '') : '';
      const ref = m.ref >= 0 ? String(row[m.ref] ?? '').trim() : (narration.match(/\b\d{12}\b/)?.[0] ?? '');
      const nref = normalizeRef(ref);
      const existing = nref ? payments.find((p) => normalizeRef(p.txnRef) === nref || (p.txnRef && nref.includes(normalizeRef(p.txnRef)))) : undefined;
      const flat = existing?.flat ?? flats.find((f) => new RegExp(`(^|[^0-9])${f}([^0-9]|$)`).test(narration)) ?? '';
      out.push({ index, date: formatDate(m.date >= 0 ? row[m.date] : ''), amount, ref, narration, flat, existing, ...this.overrides()[index] });
    });
    return out;
  });

  async onFile(ev: Event): Promise<void> {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    this.error.set('');
    try {
      const sheets = await readWorkbook(await file.arrayBuffer());
      const rows = sheets[0]?.rows ?? [];
      const hi = findStatementHeader(rows);
      if (hi < 0) throw new Error('Could not find a header row (looking for Date / Amount / Credit columns).');
      this.rows.set(rows);
      this.headerIndex.set(hi);
      this.overrides.set({});
      const hs = rows[hi].map(normalizeHeader);
      const find = (re: RegExp) => hs.findIndex((h) => re.test(h));
      this.map.set({
        date: find(/date/),
        amount: (() => {
          const credit = find(/credit|deposit|cr amount|received/);
          return credit >= 0 ? credit : find(/amount/);
        })(),
        ref: find(/utr|ref|transaction id|txn id|cheque/),
        narration: find(/narration|description|particular|remark|details/),
      });
    } catch (e) {
      this.error.set((e as Error).message);
    }
  }

  setMap(key: Field, i: number): void {
    this.map.update((m) => ({ ...m, [key]: i }));
  }

  setFlat(l: StatementLine, flat: string): void {
    this.overrides.update((o) => ({ ...o, [l.index]: { ...o[l.index], flat } }));
  }

  async recordLine(l: StatementLine): Promise<void> {
    await this.run(l, async () => {
      await this.data.addPayment({
        month: this.selected()!,
        flat: l.flat,
        amount: round2(l.amount),
        paidAt: l.date || new Date().toISOString().slice(0, 10),
        txnRef: l.ref || undefined,
        mode: 'UPI',
        note: l.narration.slice(0, 120),
        source: 'reconciliation',
        verified: true,
      });
      return 'Recorded';
    });
  }

  async verifyExisting(l: StatementLine): Promise<void> {
    await this.run(l, async () => {
      await this.data.verifyPayment(l.existing!.month, l.existing!.id);
      return 'Verified';
    });
  }

  private async run(l: StatementLine, fn: () => Promise<string>): Promise<void> {
    this.busy.set(true);
    this.error.set('');
    try {
      const done = await fn();
      this.overrides.update((o) => ({ ...o, [l.index]: { ...o[l.index], done } }));
    } catch (e) {
      this.error.set((e as Error).message);
    } finally {
      this.busy.set(false);
    }
  }
}

function findStatementHeader(rows: Row[]): number {
  for (let i = 0; i < Math.min(rows.length, 30); i++) {
    const hs = (rows[i] ?? []).map(normalizeHeader);
    if (hs.some((h) => /date/.test(h)) && hs.some((h) => /amount|credit|deposit/.test(h))) return i;
  }
  return -1;
}

function formatDate(v: unknown): string {
  if (typeof v === 'number' && v > 20000 && v < 80000) {
    // Excel serial date
    const d = new Date(Math.round((v - 25569) * 86400 * 1000));
    return d.toISOString().slice(0, 10);
  }
  const s = String(v ?? '').trim();
  const dmy = s.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})/);
  if (dmy) {
    const y = dmy[3].length === 2 ? `20${dmy[3]}` : dmy[3];
    return `${y}-${dmy[2].padStart(2, '0')}-${dmy[1].padStart(2, '0')}`;
  }
  return s.slice(0, 10);
}
