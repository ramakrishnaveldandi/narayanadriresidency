import { Pipe, PipeTransform } from '@angular/core';
import { monthLabel } from '../core/billing';

const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2, minimumFractionDigits: 0 });
const num = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 3 });

@Pipe({ name: 'inr' })
export class InrPipe implements PipeTransform {
  transform(v: number | null | undefined): string {
    return v === null || v === undefined || Number.isNaN(v) ? '-' : inr.format(v);
  }
}

@Pipe({ name: 'cell' })
export class CellPipe implements PipeTransform {
  transform(v: number | string | null | undefined): string {
    if (v === null || v === undefined || v === '') return '-';
    return typeof v === 'number' ? num.format(v) : v;
  }
}

@Pipe({ name: 'monthLabel' })
export class MonthLabelPipe implements PipeTransform {
  transform(v: string | null | undefined, short = false): string {
    return v ? monthLabel(v, short) : '';
  }
}

/** "Partially Paid" -> "partially-paid" for badge classes. */
@Pipe({ name: 'statusClass' })
export class StatusClassPipe implements PipeTransform {
  transform(v: string): string {
    return v.toLowerCase().replace(/\s+/g, '-');
  }
}
