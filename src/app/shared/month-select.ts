import { Component, inject, input } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { DataService } from '../core/data.service';
import { MonthLabelPipe } from './format';

/** Month dropdown that writes the choice to the ?month= query parameter. */
@Component({
  selector: 'app-month-select',
  imports: [MonthLabelPipe],
  template: `
    @if (data.index().length > 1) {
    <label class="field">
      Month
      <select [value]="value() ?? ''" (change)="pick($any($event.target).value)" aria-label="Select month">
        @for (m of data.index(); track m.month) {
          <option [value]="m.month" [selected]="m.month === value()">{{ m.month | monthLabel }}</option>
        }
      </select>
    </label>
    }
  `,
})
export class MonthSelect {
  readonly value = input<string | null>(null);
  protected readonly data = inject(DataService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  constructor() {
    void this.data.loadIndex();
  }

  pick(month: string): void {
    void this.router.navigate([], { relativeTo: this.route, queryParams: { month }, queryParamsHandling: 'merge' });
  }
}

/** Sort flat ids like 101, 102, …, 201 (floor then unit), falling back to text order. */
export function compareFlats(a: string, b: string): number {
  const na = Number(a);
  const nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
  return a.localeCompare(b, undefined, { numeric: true });
}

export function floorOf(flat: string): string {
  const m = flat.match(/^(\d+)\d{2}$/);
  return m ? m[1] : flat.replace(/\d+$/, '') || 'Other';
}
