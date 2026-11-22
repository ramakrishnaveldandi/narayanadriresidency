import { Component, computed, effect, inject, input, resource, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { APP_CONFIG } from '../config/app-config';
import { round2, summarizeFlat } from '../core/billing';
import { DataService } from '../core/data.service';
import { buildUpiUri, looksLikeUtr } from '../core/upi';
import { InrPipe, MonthLabelPipe } from '../shared/format';
import { QrCode } from '../shared/qr-code';
import { monthLabel } from '../core/billing';

@Component({
  selector: 'app-pay',
  imports: [RouterLink, FormsModule, InrPipe, MonthLabelPipe, QrCode],
  template: `
    <a [routerLink]="['/flat', flat()]" [queryParams]="{ month: selected() }" class="small">← Flat {{ flat() }}</a>
    <h1 style="margin-top:8px">Pay maintenance</h1>
    <p class="muted">Flat {{ flat() }} · {{ selected() | monthLabel }}</p>

    @if (record.isLoading()) {
      <div class="empty">Loading…</div>
    } @else if (!summary()) {
      <div class="empty card">No bill found.</div>
    } @else {
      <div class="layout">
        <section class="card stack">
          <h2>1. Pay with UPI</h2>
          <label class="field">
            Amount (₹)
            <input type="number" min="1" step="0.01" inputmode="decimal" [ngModel]="amount()" (ngModelChange)="amount.set(+$event)" />
          </label>
          @if (amount() < (summary()!.outstanding - tolerance) && amount() > 0) {
            <div class="small muted">Partial payment - {{ summary()!.outstanding - amount() | inr }} will remain due.</div>
          }

          <a class="btn primary block" [href]="upiUri()">Open UPI app (Google Pay, PhonePe, Paytm…)</a>
          <div class="small muted">Works on phones with a UPI app installed. On a computer, scan the QR code instead.</div>

          <div style="text-align:center">
            <app-qr-code [value]="upiUri()" [size]="220" />
            <div class="small muted">Scan with any UPI app · amount {{ amount() | inr }} is pre-filled</div>
          </div>

          <div class="payee">
            <div><span class="muted small">Pay to</span><br /><strong>{{ upi.payeeName }}</strong></div>
            <div>
              <span class="muted small">UPI ID</span><br />
              <code>{{ upi.payeeVpa }}</code>
              <button class="btn sm" type="button" (click)="copy(upi.payeeVpa)">{{ copied() ? 'Copied' : 'Copy' }}</button>
            </div>
            <div><span class="muted small">Note to add</span><br /><code>{{ note() }}</code></div>
          </div>

          <details>
            <summary class="small">Association's printed QR code (enter the amount yourself)</summary>
            <img [src]="upi.staticQrImage" alt="Association UPI QR poster" style="max-width:100%;margin-top:8px;border-radius:8px" />
          </details>
        </section>

        <section class="card stack">
          <h2>2. Tell us you paid</h2>
          <div class="alert warn small">
            Opening a UPI app does <strong>not</strong> confirm payment. Your balance updates only after the association
            verifies the transaction. Please share the UPI transaction ID (UTR, 12 digits) from your payment app.
          </div>

          @if (submitted()) {
            <div class="alert ok">{{ submitted() }}</div>
          } @else {
            <form class="stack" (ngSubmit)="submit()">
              <label class="field">UPI transaction ID / UTR <input name="ref" [(ngModel)]="ref" required autocomplete="off" placeholder="e.g. 431234567890" /></label>
              @if (ref && !isUtr(ref)) {
                <div class="small muted">UPI UTRs are usually 12 digits - please double-check.</div>
              }
              <label class="field">Amount paid (₹) <input name="paid" type="number" min="1" step="0.01" [(ngModel)]="paidAmount" required /></label>
              <label class="field">Date paid <input name="date" type="date" [(ngModel)]="paidOn" required /></label>
              @if (error()) {
                <div class="alert error small">{{ error() }}</div>
              }
              @if (data.mode === 'api') {
                <button class="btn primary" type="submit" [disabled]="busy()">Submit for verification</button>
              }
              @if (whatsApp) {
                <a class="btn" [class.primary]="data.mode !== 'api'" [href]="whatsAppLink()" target="_blank" rel="noopener">Send details on WhatsApp</a>
              }
            </form>
          }
        </section>
      </div>
    }
  `,
  styles: `
    .layout { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(320px, 100%), 1fr)); gap: 16px; align-items: start; }
    .layout > * { min-width: 0; }
    .layout .card { margin: 0; }
    .payee { display: grid; gap: 10px; background: var(--surface-2); border-radius: 10px; padding: 12px; }
    .payee code { word-break: break-all; margin-right: 6px; }
  `,
})
export class Pay {
  readonly flat = input.required<string>();
  readonly month = input<string>();
  protected readonly data = inject(DataService);
  protected readonly upi = APP_CONFIG.upi;
  protected readonly tolerance = APP_CONFIG.paidTolerance;
  protected readonly whatsApp = APP_CONFIG.contactWhatsApp;

  protected readonly selected = computed(() => this.month() || this.data.latestMonth());
  protected readonly record = resource({
    params: () => this.selected() ?? undefined,
    loader: ({ params }) => this.data.getMonth(params),
  });
  protected readonly summary = computed(() => {
    const r = this.record.value();
    return r && r.bill.flats.some((f) => f.flat === this.flat()) ? summarizeFlat(r, this.flat(), this.tolerance) : null;
  });

  protected readonly amount = signal(0);
  protected readonly copied = signal(false);
  protected readonly busy = signal(false);
  protected readonly error = signal('');
  protected readonly submitted = signal('');
  protected ref = '';
  protected paidAmount = 0;
  protected paidOn = new Date().toISOString().slice(0, 10);

  protected readonly note = computed(() => {
    const m = this.selected();
    const short = m ? monthLabel(m, true).replace(' ', '-') : '';
    return `${APP_CONFIG.upi.notePrefix} ${short} Flat ${this.flat()}`;
  });
  protected readonly upiUri = computed(() =>
    buildUpiUri({ payeeVpa: this.upi.payeeVpa, payeeName: this.upi.payeeName, amount: round2(this.amount()), note: this.note() }),
  );

  constructor() {
    void this.data.loadIndex();
    effect(() => {
      const s = this.summary();
      if (s) {
        const due = Math.max(0, s.outstanding);
        this.amount.set(due);
        this.paidAmount = due;
      }
    });
  }

  protected isUtr(ref: string): boolean {
    return looksLikeUtr(ref);
  }

  protected whatsAppLink(): string {
    const text =
      `Maintenance payment - ${APP_CONFIG.apartmentName}\n` +
      `Flat: ${this.flat()}\nMonth: ${this.selected() ? monthLabel(this.selected()!) : ''}\n` +
      `Amount: ₹${this.paidAmount}\nUTR: ${this.ref || '(add UTR)'}\nDate: ${this.paidOn}`;
    return `https://wa.me/${this.whatsApp}?text=${encodeURIComponent(text)}`;
  }

  protected async copy(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      this.copied.set(true);
      setTimeout(() => this.copied.set(false), 2000);
    } catch {
      /* clipboard blocked - the ID is visible to copy manually */
    }
  }

  protected async submit(): Promise<void> {
    if (this.data.mode !== 'api') return;
    this.error.set('');
    if (!this.ref.trim()) return this.error.set('Enter the transaction ID.');
    if (!(this.paidAmount > 0)) return this.error.set('Enter the amount paid.');
    this.busy.set(true);
    try {
      await this.data.addPayment({
        month: this.selected()!,
        flat: this.flat(),
        amount: round2(this.paidAmount),
        paidAt: this.paidOn,
        txnRef: this.ref.trim(),
        mode: 'UPI',
        source: 'resident',
        verified: false,
      });
      this.submitted.set('Thank you. Your payment details were submitted and will be verified by the association.');
      this.record.reload();
    } catch (e) {
      this.error.set((e as Error).message);
    } finally {
      this.busy.set(false);
    }
  }
}
