import { Component, inject, input, signal } from '@angular/core';
import { DataService } from '../core/data.service';
import { MonthLabelPipe } from './format';

/** "Original maintenance sheet" - downloads the month's Excel file from Google Drive (NR Maintenance / Latest). */
@Component({
  selector: 'app-source-file-viewer',
  imports: [MonthLabelPipe],
  template: `
    @if (data.mode === 'api') {
      <div class="card row" style="padding:12px 16px">
        <span class="spacer"><strong>Original maintenance sheet</strong> <span class="muted small">· {{ month() | monthLabel }} (Excel)</span></span>
        @if (missing()) {
          <span class="muted small">Not available</span>
        } @else {
          <button class="btn sm" type="button" (click)="download()" [disabled]="busy()">{{ busy() ? 'Downloading…' : 'Download' }}</button>
        }
        @if (error()) {
          <span class="small" style="color:var(--bad)">{{ error() }}</span>
        }
      </div>
    }
  `,
})
export class SourceFileViewer {
  readonly month = input.required<string>();
  protected readonly data = inject(DataService);
  protected readonly busy = signal(false);
  protected readonly missing = signal(false);
  protected readonly error = signal('');

  async download(): Promise<void> {
    this.busy.set(true);
    this.error.set('');
    try {
      const f = await this.data.getSourceFile(this.month());
      if (!f) {
        this.missing.set(true);
        return;
      }
      const bin = atob(f.base64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const url = URL.createObjectURL(new Blob([bytes], { type: f.mimeType }));
      const a = document.createElement('a');
      a.href = url;
      a.download = f.name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      this.error.set((e as Error).message);
    } finally {
      this.busy.set(false);
    }
  }
}
