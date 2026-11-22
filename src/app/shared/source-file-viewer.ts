import { Component, inject, input, signal } from '@angular/core';
import { DataService } from '../core/data.service';
import { MonthLabelPipe } from './format';

/**
 * "View original maintenance sheet" - loads the month's source image / Excel from
 * Google Drive (NR Maintenance / Latest) on demand. Only shown in API mode.
 */
@Component({
  selector: 'app-source-file-viewer',
  imports: [MonthLabelPipe],
  template: `
    @if (data.mode === 'api') {
      <div class="card" style="padding:12px 16px">
        <div class="row">
          <span class="spacer"><strong>Original maintenance sheet</strong> <span class="muted small">· {{ month() | monthLabel }}</span></span>
          @if (!url() && !missing()) {
            <button class="btn sm" type="button" (click)="load()" [disabled]="busy()">{{ busy() ? 'Loading…' : 'View' }}</button>
          }
          @if (url()) {
            <a class="btn sm" [href]="url()" [download]="name()">Download</a>
          }
        </div>
        @if (missing()) {
          <p class="muted small" style="margin:8px 0 0">No original file was saved for this month.</p>
        }
        @if (error()) {
          <p class="small" style="margin:8px 0 0;color:var(--bad)">{{ error() }}</p>
        }
        @if (url() && isImage()) {
          <img [src]="url()" [alt]="'Maintenance sheet ' + month()" style="width:100%;margin-top:12px;border-radius:8px;border:1px solid var(--border)" />
        }
      </div>
    }
  `,
})
export class SourceFileViewer {
  readonly month = input.required<string>();
  protected readonly data = inject(DataService);
  protected readonly url = signal<string | null>(null);
  protected readonly name = signal('');
  protected readonly isImage = signal(false);
  protected readonly busy = signal(false);
  protected readonly missing = signal(false);
  protected readonly error = signal('');

  async load(): Promise<void> {
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
      this.url.set(URL.createObjectURL(new Blob([bytes], { type: f.mimeType })));
      this.name.set(f.name);
      this.isImage.set(f.mimeType.startsWith('image/'));
    } catch (e) {
      this.error.set((e as Error).message);
    } finally {
      this.busy.set(false);
    }
  }
}
