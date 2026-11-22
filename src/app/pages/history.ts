import { Component, computed, inject, input, resource, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { APP_CONFIG } from '../config/app-config';
import { monthLabel, summarizeFlat, summarizeMonth } from '../core/billing';
import { DataService } from '../core/data.service';
import { InrPipe, MonthLabelPipe, StatusClassPipe } from '../shared/format';
import { compareFlats } from '../shared/month-select';

@Component({
  selector: 'app-history',
  imports: [RouterLink, FormsModule, InrPipe, MonthLabelPipe, StatusClassPipe],
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

    @if (message()) {
      <div class="alert ok">
        {{ message() }} <a routerLink="/admin/import">Upload the corrected sheet →</a>
      </div>
    }
    @if (error()) {
      <div class="alert error">{{ error() }}</div>
    }

    @if (months.isLoading()) {
      <div class="empty">Loading…</div>
    } @else if (!rows().length) {
      <div class="empty card">No history available. <a routerLink="/admin/import">Import a month</a></div>
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
            @for (r of rows(); track r.month; let first = $first) {
              <tr>
                <td>
                  {{ r.month | monthLabel }}
                  @if (first) {
                    <span class="badge info">Shown to residents</span>
                  }
                </td>
                <td class="num">{{ r.due | inr }}</td>
                <td class="num">{{ r.paid | inr }}</td>
                <td class="num">{{ r.outstanding | inr }}</td>
                @if (flat()) {
                  <td><span class="badge" [class]="r.status! | statusClass">{{ r.status }}</span></td>
                }
                <td class="row" style="flex-wrap:nowrap;gap:8px">
                  @if (flat()) {
                    <a [routerLink]="['/flat', flat()]" [queryParams]="{ month: r.month }">Details</a>
                  } @else {
                    <a routerLink="/" [queryParams]="{ month: r.month }">Open</a>
                    <button class="btn sm danger" type="button" (click)="askDelete(r.month)" [disabled]="busy()">Delete</button>
                  }
                </td>
              </tr>
              @if (confirming() === r.month) {
                <tr class="confirm">
                  <td [attr.colspan]="flat() ? 6 : 5">
                    <div class="stack">
                      <strong>Delete {{ r.month | monthLabel }}?</strong>
                      <ul class="small" style="margin:0;padding-left:20px">
                        <li>The bill for all {{ r.flats }} flats is removed from the app{{ data.mode === 'api' ? ', and its Excel and data files are moved to the Google Drive Trash (restorable for 30 days)' : '' }}.</li>
                        <li>{{ r.paymentCount }} recorded payment(s) are <strong>kept</strong> and show again when you re-upload this month.</li>
                        @if (first) {
                          <li>
                            Residents will see
                            <strong>{{ nextLatest() ? (nextLatest()! | monthLabel) : 'no bill' }}</strong>
                            until you upload this month again.
                          </li>
                        }
                      </ul>
                      <label class="field">Reason <input [(ngModel)]="reason" placeholder="e.g. wrong readings for flat 304" /></label>
                      <label class="field">
                        Type <code>{{ r.month }}</code> to confirm
                        <input [(ngModel)]="typed" [placeholder]="r.month" autocomplete="off" />
                      </label>
                      <div class="row">
                        <button class="btn danger" type="button" (click)="confirmDelete(r.month)" [disabled]="busy() || typed.trim() !== r.month || !reason.trim()">
                          {{ busy() ? 'Deleting…' : 'Delete ' + (r.month | monthLabel) }}
                        </button>
                        <button class="btn" type="button" (click)="cancel()" [disabled]="busy()">Cancel</button>
                      </div>
                    </div>
                  </td>
                </tr>
              }
            }
          </tbody>
        </table>
      </div>
    }
  `,
  styles: `
    tr.confirm td { background: var(--bad-soft); }
  `,
})
export class History {
  readonly flat = input<string>();
  protected readonly data = inject(DataService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  protected readonly months = resource({ loader: () => this.data.getAllMonths() });
  protected readonly confirming = signal<string | null>(null);
  protected readonly busy = signal(false);
  protected readonly message = signal('');
  protected readonly error = signal('');
  protected typed = '';
  protected reason = '';

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
        const base = { month: r.bill.month, flats: r.bill.flats.length, paymentCount: r.payments.filter((p) => !p.voided).length };
        if (flat) {
          const s = summarizeFlat(r, flat, tol);
          return { ...base, due: s.due, paid: s.paid, outstanding: s.outstanding, status: s.status };
        }
        const s = summarizeMonth(r, tol);
        return { ...base, due: s.billed, paid: s.collected, outstanding: s.outstanding, status: null };
      })
      .sort((a, b) => b.month.localeCompare(a.month));
  });

  /** Month residents will see if the latest one is deleted. */
  protected readonly nextLatest = computed(() => this.rows()[1]?.month ?? null);

  protected pickFlat(flat: string): void {
    void this.router.navigate([], { relativeTo: this.route, queryParams: { flat: flat || null } });
  }

  protected askDelete(month: string): void {
    this.confirming.set(month);
    this.typed = '';
    this.reason = '';
    this.message.set('');
    this.error.set('');
  }

  protected cancel(): void {
    this.confirming.set(null);
  }

  protected async confirmDelete(month: string): Promise<void> {
    if (this.typed.trim() !== month || !this.reason.trim()) return;
    this.busy.set(true);
    this.error.set('');
    try {
      await this.data.deleteMonth(month, this.reason.trim());
      this.confirming.set(null);
      const latest = this.data.latestMonth();
      this.message.set(
        `Deleted ${monthLabel(month)}. Residents now see ${latest ? monthLabel(latest) : 'no bill'}.` +
          (this.data.mode === 'static' ? ' Export the data files from Reports & backup to publish this change.' : ''),
      );
      this.months.reload();
    } catch (e) {
      this.error.set((e as Error).message);
    } finally {
      this.busy.set(false);
    }
  }
}
