import { Component, computed, inject, input, resource, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { APP_CONFIG } from '../config/app-config';
import { summarizeFlat, summarizeMonth } from '../core/billing';
import { DataService } from '../core/data.service';
import type { FlatSummary } from '../core/models';
import { InrPipe, MonthLabelPipe, StatusClassPipe } from '../shared/format';
import { MonthSelect, compareFlats, floorOf } from '../shared/month-select';

@Component({
  selector: 'app-dashboard',
  imports: [RouterLink, InrPipe, MonthLabelPipe, StatusClassPipe, MonthSelect],
  template: `
    <div class="row" style="align-items:flex-end;margin-bottom:16px">
      <div class="spacer">
        <h1>{{ name }}</h1>
        <div class="muted">Monthly maintenance · {{ selected() | monthLabel }}</div>
      </div>
      <app-month-select [value]="selected()" />
    </div>

    @if (record.isLoading()) {
      <div class="empty">Loading…</div>
    } @else if (record.error()) {
      <div class="alert error">Could not load data: {{ $any(record.error())?.message }}</div>
    } @else if (!record.value()) {
      <div class="empty card">No maintenance data has been published yet.</div>
    } @else {
      @let s = summary()!;
      <section class="stats" aria-label="Month summary">
        <div class="stat"><div class="label">Flats</div><div class="value">{{ s.flatCount }}</div></div>
        <div class="stat"><div class="label">Total billed</div><div class="value">{{ s.billed | inr }}</div></div>
        <div class="stat"><div class="label">Collected (verified)</div><div class="value">{{ s.collected | inr }}</div></div>
        <div class="stat"><div class="label">Outstanding</div><div class="value">{{ s.outstanding | inr }}</div></div>
      </section>
      @if (showStatus) {
        <div class="row small" style="margin-bottom:12px">
          <span class="badge paid">{{ s.paidCount }} Paid</span>
          <span class="badge partially-paid">{{ s.partialCount }} Partially paid</span>
          <span class="badge pending">{{ s.pendingCount }} Pending</span>
        </div>
      }

      <div class="row" style="margin-bottom:12px">
        <input type="search" placeholder="Find your flat (e.g. 304)" aria-label="Find flat" [value]="query()" (input)="query.set($any($event.target).value)" style="flex:1;max-width:320px" />
      </div>

      @for (group of floors(); track group.floor) {
        <h3 class="muted small" style="margin-top:8px">Floor {{ group.floor }}</h3>
        <div class="grid">
          @for (f of group.flats; track f.flat) {
            <a class="flat" [routerLink]="['/flat', f.flat]" [queryParams]="{ month: selected() }">
              <span class="no">{{ f.flat }}</span>
              @if (showAmounts) {
                <span class="amt">{{ f.due | inr }}</span>
              }
              @if (showStatus) {
                <span class="badge" [class]="f.status | statusClass">{{ f.status }}</span>
              }
            </a>
          }
        </div>
      } @empty {
        <div class="empty">No flat matches "{{ query() }}".</div>
      }
    }
  `,
  styles: `
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 10px; margin-bottom: 8px; }
    .flat { display: flex; flex-direction: column; gap: 4px; align-items: flex-start; padding: 12px 14px; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); color: var(--text); text-decoration: none; box-shadow: var(--shadow); }
    .flat:hover { border-color: var(--primary); }
    .no { font-size: 1.25rem; font-weight: 800; }
    .amt { font-variant-numeric: tabular-nums; font-weight: 600; }
  `,
})
export class Dashboard {
  /** ?month= query parameter. */
  readonly month = input<string>();
  private readonly data = inject(DataService);
  protected readonly name = APP_CONFIG.apartmentName;
  protected readonly showAmounts = APP_CONFIG.visibility !== 'flats-only';
  protected readonly showStatus = APP_CONFIG.visibility === 'full';
  protected readonly query = signal('');

  protected readonly selected = computed(() => this.month() || this.data.latestMonth());

  protected readonly record = resource({
    params: () => this.selected() ?? undefined,
    loader: ({ params }) => this.data.getMonth(params),
  });

  constructor() {
    void this.data.loadIndex();
  }

  protected readonly summary = computed(() => {
    const r = this.record.value();
    return r ? summarizeMonth(r, APP_CONFIG.paidTolerance) : null;
  });

  protected readonly floors = computed(() => {
    const r = this.record.value();
    if (!r) return [];
    const q = this.query().trim().toLowerCase();
    const flats: FlatSummary[] = r.bill.flats
      .map((f) => summarizeFlat(r, f.flat, APP_CONFIG.paidTolerance))
      .filter((f) => !q || f.flat.toLowerCase().includes(q))
      .sort((a, b) => compareFlats(a.flat, b.flat));
    const groups = new Map<string, FlatSummary[]>();
    for (const f of flats) {
      const key = floorOf(f.flat);
      groups.set(key, [...(groups.get(key) ?? []), f]);
    }
    return [...groups.entries()].map(([floor, list]) => ({ floor, flats: list }));
  });
}
