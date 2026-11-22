import { Component, computed, inject, input, resource, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { APP_CONFIG } from '../../config/app-config';
import { round2, summarizeFlat } from '../../core/billing';
import { DataService } from '../../core/data.service';
import type { Payment } from '../../core/models';
import { InrPipe, MonthLabelPipe, StatusClassPipe } from '../../shared/format';
import { MonthSelect, compareFlats } from '../../shared/month-select';

@Component({
  selector: 'app-admin-payments',
  imports: [FormsModule, DatePipe, InrPipe, MonthLabelPipe, StatusClassPipe, MonthSelect],
  template: `
    <div class="row" style="align-items:flex-end;margin-bottom:12px">
      <h2 class="spacer">Payments · {{ selected() | monthLabel }}</h2>
      <app-month-select [value]="selected()" />
    </div>

    @if (error()) {
      <div class="alert error">{{ error() }}</div>
    }
    @if (message()) {
      <div class="alert ok">{{ message() }}</div>
    }

    @if (pending().length) {
      <section class="card stack">
        <h3>Awaiting verification ({{ pending().length }})</h3>
        <p class="small muted">Submitted by residents. Check each reference against the bank / UPI statement before verifying.</p>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Flat</th><th>Paid on</th><th>Reference</th><th class="num">Amount</th><th></th></tr></thead>
            <tbody>
              @for (p of pending(); track p.id) {
                <tr>
                  <td>{{ p.flat }}</td>
                  <td>{{ p.paidAt | date: 'mediumDate' }}</td>
                  <td>{{ p.txnRef }}</td>
                  <td class="num">{{ p.amount | inr }}</td>
                  <td class="row" style="flex-wrap:nowrap">
                    <button class="btn sm primary" type="button" (click)="verify(p)" [disabled]="busy()">Verify</button>
                    <button class="btn sm danger" type="button" (click)="voidPayment(p)" [disabled]="busy()">Reject</button>
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      </section>
    }

    <section class="card stack">
      <h3>Record a payment</h3>
      <form class="form-grid" (ngSubmit)="recordPayment()">
        <label class="field">
          Flat
          <select name="flat" [(ngModel)]="form.flat" (ngModelChange)="prefill()" required>
            <option value="" disabled>Select</option>
            @for (f of balances(); track f.flat) {
              <option [value]="f.flat">{{ f.flat }} - due {{ f.outstanding | inr }}</option>
            }
          </select>
        </label>
        <label class="field">Amount (₹) <input name="amount" type="number" min="1" step="0.01" [(ngModel)]="form.amount" required /></label>
        <label class="field">Paid on <input name="paidAt" type="date" [(ngModel)]="form.paidAt" required /></label>
        <label class="field">UTR / reference <input name="ref" [(ngModel)]="form.txnRef" autocomplete="off" /></label>
        <label class="field">
          Mode
          <select name="mode" [(ngModel)]="form.mode">
            <option>UPI</option><option>Bank transfer</option><option>Cash</option><option>Cheque</option>
          </select>
        </label>
        <label class="field">Note <input name="note" [(ngModel)]="form.note" /></label>
        <div style="align-self:end"><button class="btn primary block" type="submit" [disabled]="busy()">Record verified payment</button></div>
      </form>
    </section>

    <section class="card stack">
      <h3>Balances</h3>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Flat</th><th class="num">Due</th><th class="num">Paid</th><th class="num">Outstanding</th><th>Status</th></tr></thead>
          <tbody>
            @for (f of balances(); track f.flat) {
              <tr>
                <td>{{ f.flat }}</td>
                <td class="num">{{ f.due | inr }}</td>
                <td class="num">{{ f.paid | inr }}</td>
                <td class="num">{{ f.outstanding | inr }}</td>
                <td><span class="badge" [class]="f.status | statusClass">{{ f.status }}</span></td>
              </tr>
            }
          </tbody>
        </table>
      </div>
    </section>

    <section class="card stack">
      <h3>Ledger</h3>
      @if (ledger().length) {
        <div class="table-wrap">
          <table>
            <thead><tr><th>Flat</th><th>Paid on</th><th>Reference</th><th>Mode</th><th class="num">Amount</th><th>Status</th><th>Recorded</th><th></th></tr></thead>
            <tbody>
              @for (p of ledger(); track p.id) {
                <tr [class.void]="p.voided">
                  <td>{{ p.flat }}</td>
                  <td>{{ p.paidAt | date: 'mediumDate' }}</td>
                  <td>{{ p.txnRef || '-' }}</td>
                  <td>{{ p.mode || '-' }}</td>
                  <td class="num">{{ p.amount | inr }}</td>
                  <td>
                    @if (p.voided) {
                      <span class="badge pending" [title]="p.voidReason ?? ''">Void</span>
                    } @else if (p.verified) {
                      <span class="badge paid">Verified</span>
                    } @else {
                      <span class="badge info">Unverified</span>
                    }
                  </td>
                  <td class="small muted">{{ p.recordedBy }} · {{ p.recordedAt | date: 'short' }}</td>
                  <td>
                    @if (!p.voided) {
                      <button class="btn sm danger" type="button" (click)="voidPayment(p)" [disabled]="busy()">Void</button>
                    }
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </div>
        <p class="small muted">Payments are never deleted. Voiding keeps the entry with a reason in the audit trail.</p>
      } @else {
        <p class="muted">No payments for this month yet.</p>
      }
    </section>
  `,
  styles: `tr.void td { text-decoration: line-through; opacity: 0.6; }`,
})
export class AdminPayments {
  readonly month = input<string>();
  private readonly data = inject(DataService);
  protected readonly busy = signal(false);
  protected readonly error = signal('');
  protected readonly message = signal('');

  protected readonly selected = computed(() => this.data.resolveMonth(this.month()));
  protected readonly record = resource({
    params: () => this.selected() ?? undefined,
    loader: ({ params }) => this.data.getMonth(params, true),
  });

  protected form = this.emptyForm();

  protected readonly balances = computed(() => {
    const r = this.record.value();
    if (!r) return [];
    return r.bill.flats.map((f) => summarizeFlat(r, f.flat, APP_CONFIG.paidTolerance)).sort((a, b) => compareFlats(a.flat, b.flat));
  });
  protected readonly pending = computed(() => (this.record.value()?.payments ?? []).filter((p) => !p.verified && !p.voided));
  protected readonly ledger = computed(() =>
    [...(this.record.value()?.payments ?? [])].sort((a, b) => b.recordedAt.localeCompare(a.recordedAt)),
  );

  constructor() {
    void this.data.loadIndex();
  }

  protected prefill(): void {
    const b = this.balances().find((f) => f.flat === this.form.flat);
    if (b) this.form.amount = Math.max(0, b.outstanding);
  }

  async recordPayment(): Promise<void> {
    const month = this.selected();
    if (!month || !this.form.flat) return this.error.set('Select a flat.');
    await this.run(async () => {
      await this.data.addPayment({
        month,
        flat: this.form.flat,
        amount: round2(Number(this.form.amount)),
        paidAt: this.form.paidAt,
        txnRef: this.form.txnRef,
        mode: this.form.mode,
        note: this.form.note || undefined,
        source: 'admin',
        verified: true,
      });
      this.message.set(`Recorded ₹${this.form.amount} for flat ${this.form.flat}.`);
      this.form = this.emptyForm();
    });
  }

  async verify(p: Payment): Promise<void> {
    await this.run(async () => {
      await this.data.verifyPayment(p.month, p.id);
      this.message.set(`Verified ₹${p.amount} from flat ${p.flat}.`);
    });
  }

  async voidPayment(p: Payment): Promise<void> {
    const reason = prompt(`Reason for voiding ₹${p.amount} (flat ${p.flat}, ref ${p.txnRef ?? '-'}):`);
    if (!reason) return;
    await this.run(async () => {
      await this.data.voidPayment(p.month, p.id, reason);
      this.message.set(`Voided payment from flat ${p.flat}.`);
    });
  }

  private emptyForm() {
    return { flat: '', amount: 0, paidAt: new Date().toISOString().slice(0, 10), txnRef: '', mode: 'UPI', note: '' };
  }

  private async run(fn: () => Promise<void>): Promise<void> {
    this.busy.set(true);
    this.error.set('');
    this.message.set('');
    try {
      await fn();
      this.record.reload();
    } catch (e) {
      this.error.set((e as Error).message);
    } finally {
      this.busy.set(false);
    }
  }
}
