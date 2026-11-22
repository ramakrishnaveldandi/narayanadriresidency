import { Component, computed, inject, input, resource } from '@angular/core';
import { DatePipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { APP_CONFIG } from '../config/app-config';
import { summarizeFlat } from '../core/billing';
import { DataService } from '../core/data.service';
import { AdminAuthService } from '../core/admin-auth.service';
import { CellPipe, InrPipe, MonthLabelPipe, StatusClassPipe } from '../shared/format';
import { MonthSelect } from '../shared/month-select';
import { PageLoader } from '../shared/page-loader';

@Component({
  selector: 'app-flat-detail',
  imports: [RouterLink, DatePipe, InrPipe, CellPipe, MonthLabelPipe, StatusClassPipe, MonthSelect, PageLoader],
  template: `
    <a routerLink="/" [queryParams]="{ month: selected() }" class="small">← All flats</a>
    <div class="row" style="align-items:flex-end;margin:8px 0 16px">
      <div class="spacer">
        <h1>Flat {{ flat() }}</h1>
        <div class="muted">{{ selected() | monthLabel }} maintenance</div>
      </div>
      <app-month-select [value]="selected()" />
    </div>

    @if (data.indexLoading() || record.isLoading()) {
      <app-page-loader message="Loading flat {{ flat() }}…" />
    } @else if (!bill()) {
      <div class="empty card">No bill for flat {{ flat() }} in {{ selected() | monthLabel }}.</div>
    } @else {
      @let s = summary()!;
      <div class="card">
        <div class="row">
          <div class="spacer">
            <div class="muted small">Outstanding balance</div>
            <div style="font-size:2rem;font-weight:800" class="num" [style.text-align]="'left'">{{ max0(s.outstanding) | inr }}</div>
          </div>
          <span class="badge" [class]="s.status | statusClass">{{ s.status }}</span>
        </div>
        @if (s.awaitingVerification > 0) {
          <div class="alert info small" style="margin-top:12px">
            {{ s.awaitingVerification | inr }} submitted by the resident is awaiting verification and is not yet deducted.
          </div>
        }
        @if (s.outstanding > tolerance) {
          <a class="btn primary block" style="margin-top:12px" [routerLink]="['/pay', flat()]" [queryParams]="{ month: selected() }">Pay {{ s.outstanding | inr }} now</a>
        }
      </div>

      <div class="card">
        <h2>Bill breakdown</h2>
        <div class="table-wrap">
          <table>
            <tbody>
              @for (c of expenseColumns(); track c.key) {
                <tr><td>{{ c.label }}</td><td class="num">{{ $any(bill()!.values[c.key]) | inr }}</td></tr>
              }
            </tbody>
            <tfoot>
              <tr><td>Total due</td><td class="num">{{ s.due | inr }}</td></tr>
              <tr><td>Paid (verified)</td><td class="num">− {{ s.paid | inr }}</td></tr>
              <tr><td>Balance</td><td class="num">{{ s.outstanding | inr }}</td></tr>
            </tfoot>
          </table>
        </div>

        @if (infoColumns().length) {
          <details style="margin-top:12px">
            <summary>Water meter &amp; calculation details</summary>
            <div class="table-wrap" style="margin-top:8px">
              <table>
                <tbody>
                  @for (c of infoColumns(); track c.key) {
                    <tr><td>{{ c.label }}</td><td class="num">{{ bill()!.values[c.key] | cell }}</td></tr>
                  }
                </tbody>
              </table>
            </div>
          </details>
        }
        <p class="muted small" style="margin-bottom:0">
          Source: {{ record.value()!.bill.source.fileName }}{{ bill()!.sourceRow ? ', row ' + bill()!.sourceRow : '' }} ·
          published {{ record.value()!.bill.publishedAt | date: 'mediumDate' }} (v{{ record.value()!.bill.version }})
        </p>
      </div>

      <div class="card">
        <h2>Payments for {{ selected() | monthLabel }}</h2>
        @if (payments().length) {
          <div class="table-wrap">
            <table>
              <thead><tr><th>Date</th><th>Reference</th><th class="num">Amount</th><th>Status</th></tr></thead>
              <tbody>
                @for (p of payments(); track p.id) {
                  <tr>
                    <td>{{ p.paidAt | date: 'mediumDate' }}</td>
                    <td>{{ p.txnRef || '-' }}</td>
                    <td class="num">{{ p.amount | inr }}</td>
                    <td>
                      @if (p.verified) {
                        <span class="badge paid">Verified</span>
                      } @else {
                        <span class="badge info">Awaiting verification</span>
                      }
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        } @else {
          <p class="muted">No payments recorded yet.</p>
        }
        @if (auth.isAdmin()) {
          <a class="small" routerLink="/history" [queryParams]="{ flat: flat() }">See all months for flat {{ flat() }} →</a>
        }
      </div>
    }
  `,
})
export class FlatDetail {
  readonly flat = input.required<string>();
  readonly month = input<string>();
  protected readonly data = inject(DataService);
  protected readonly auth = inject(AdminAuthService);
  protected readonly tolerance = APP_CONFIG.paidTolerance;

  protected readonly selected = computed(() => this.data.resolveMonth(this.month()));
  protected readonly record = resource({
    params: () => this.selected() ?? undefined,
    loader: ({ params }) => this.data.getMonth(params),
  });

  constructor() {
    void this.data.loadIndex();
  }

  protected readonly bill = computed(() => this.record.value()?.bill.flats.find((f) => f.flat === this.flat()) ?? null);
  /** Line items that apply to this flat (extra charges left blank for it are not shown). */
  protected readonly expenseColumns = computed(() => {
    const values = this.bill()?.values ?? {};
    return (this.record.value()?.bill.columns ?? []).filter((c) => c.role === 'expense' && values[c.key] !== null && values[c.key] !== undefined && values[c.key] !== '');
  });
  protected readonly infoColumns = computed(() => this.record.value()?.bill.columns.filter((c) => c.role === 'info') ?? []);
  protected readonly summary = computed(() => {
    const r = this.record.value();
    return r ? summarizeFlat(r, this.flat(), APP_CONFIG.paidTolerance) : null;
  });
  protected readonly payments = computed(() =>
    (this.record.value()?.payments ?? []).filter((p) => p.flat === this.flat() && !p.voided).sort((a, b) => a.paidAt.localeCompare(b.paidAt)),
  );

  protected max0(n: number): number {
    return Math.max(0, n);
  }
}
