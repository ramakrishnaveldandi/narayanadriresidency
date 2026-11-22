import { Component, computed, inject, input, resource } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { APP_CONFIG } from '../config/app-config';
import { summarizeFlat, summarizeMonth } from '../core/billing';
import { DataService } from '../core/data.service';
import { InrPipe, MonthLabelPipe, StatusClassPipe } from '../shared/format';
import { compareFlats } from '../shared/month-select';

@Component({
  selector: 'app-history',
  imports: [RouterLink, InrPipe, MonthLabelPipe, StatusClassPipe],
  template: `
    <div class="row" style="align-items:flex-end;margin-bottom:16px">
      <div class="spacer">
        <h1>Monthly history</h1>
        <div class="muted">{{ flat() ? 'Flat ' + flat() : 'Whole apartment' }} · all published months</div>
      </div>
      <label class="field">
        Flat
        <select (change)="pickFlat($any($event.target).value)" aria-label="Select flat">
          <option value="" [selected]="!flat()">All flats</option>
          @for (f of allFlats(); track f) {
            <option [value]="f" [selected]="f === flat()">{{ f }}</option>
          }
        </select>
      </label>
    </div>

    @if (months.isLoading()) {
      <div class="empty">Loading…</div>
    } @else if (!rows().length) {
      <div class="empty card">No history available.</div>
    } @else {
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Month</th>
              <th class="num">{{ flat() ? 'Due' : 'Billed' }}</th>
              <th class="num">{{ flat() ? 'Paid' : 'Collected' }}</th>
              <th class="num">Outstanding</th>
              @if (flat()) {
                <th>Status</th>
              }
              <th></th>
            </tr>
          </thead>
          <tbody>
            @for (r of rows(); track r.month) {
              <tr>
                <td>{{ r.month | monthLabel }}</td>
                <td class="num">{{ r.due | inr }}</td>
                <td class="num">{{ r.paid | inr }}</td>
                <td class="num">{{ r.outstanding | inr }}</td>
                @if (flat()) {
                  <td><span class="badge" [class]="r.status! | statusClass">{{ r.status }}</span></td>
                }
                <td>
                  @if (flat()) {
                    <a [routerLink]="['/flat', flat()]" [queryParams]="{ month: r.month }">Details</a>
                  } @else {
                    <a routerLink="/" [queryParams]="{ month: r.month }">Open</a>
                  }
                </td>
              </tr>
            }
          </tbody>
        </table>
      </div>
    }
  `,
})
export class History {
  readonly flat = input<string>();
  private readonly data = inject(DataService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  protected readonly months = resource({ loader: () => this.data.getAllMonths() });

  protected readonly allFlats = computed(() => {
    const set = new Set<string>();
    for (const r of this.months.value() ?? []) for (const f of r.bill.flats) set.add(f.flat);
    return [...set].sort(compareFlats);
  });

  protected readonly rows = computed(() => {
    const tol = APP_CONFIG.paidTolerance;
    const flat = this.flat();
    return (this.months.value() ?? [])
      .filter((r) => !flat || r.bill.flats.some((f) => f.flat === flat))
      .map((r) => {
        if (flat) {
          const s = summarizeFlat(r, flat, tol);
          return { month: r.bill.month, due: s.due, paid: s.paid, outstanding: s.outstanding, status: s.status };
        }
        const s = summarizeMonth(r, tol);
        return { month: r.bill.month, due: s.billed, paid: s.collected, outstanding: s.outstanding, status: null };
      })
      .sort((a, b) => b.month.localeCompare(a.month));
  });

  protected pickFlat(flat: string): void {
    void this.router.navigate([], { relativeTo: this.route, queryParams: { flat: flat || null } });
  }
}
