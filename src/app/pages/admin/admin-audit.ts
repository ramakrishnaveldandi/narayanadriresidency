import { Component, computed, inject, input, resource } from '@angular/core';
import { DatePipe } from '@angular/common';
import { DataService } from '../../core/data.service';
import { MonthLabelPipe } from '../../shared/format';
import { MonthSelect } from '../../shared/month-select';

@Component({
  selector: 'app-admin-audit',
  imports: [DatePipe, MonthLabelPipe, MonthSelect],
  template: `
    <div class="row" style="align-items:flex-end;margin-bottom:12px">
      <h2 class="spacer">Audit trail · {{ selected() | monthLabel }}</h2>
      <app-month-select [value]="selected()" />
    </div>
    @if (entries().length) {
      <div class="table-wrap">
        <table>
          <thead><tr><th>When</th><th>Who</th><th>Action</th><th>Details</th></tr></thead>
          <tbody>
            @for (a of entries(); track $index) {
              <tr>
                <td class="small">{{ a.at | date: 'medium' }}</td>
                <td>{{ a.actor }}</td>
                <td><span class="badge info">{{ a.action }}</span></td>
                <td class="small">{{ a.details }}</td>
              </tr>
            }
          </tbody>
        </table>
      </div>
    } @else {
      <div class="empty card">No audit entries for this month.</div>
    }
  `,
})
export class AdminAudit {
  readonly month = input<string>();
  private readonly data = inject(DataService);
  protected readonly selected = computed(() => this.month() || this.data.latestMonth());
  protected readonly record = resource({
    params: () => this.selected() ?? undefined,
    loader: ({ params }) => this.data.getMonth(params, true),
  });
  protected readonly entries = computed(() => [...(this.record.value()?.audit ?? [])].sort((a, b) => b.at.localeCompare(a.at)));

  constructor() {
    void this.data.loadIndex();
  }
}
