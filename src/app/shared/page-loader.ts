import { Component, input } from '@angular/core';

/** Spinner + placeholder blocks shown while data is loading (the backend can take a few seconds to wake up). */
@Component({
  selector: 'app-page-loader',
  template: `
    <div class="loader" role="status" aria-live="polite">
      <span class="spinner" aria-hidden="true"></span>
      <span>{{ message() }}</span>
    </div>
    @if (variant() === 'cards') {
      <div class="sk-stats">
        @for (i of [1, 2, 3, 4]; track i) {
          <div class="sk sk-stat"></div>
        }
      </div>
      <div class="sk-grid">
        @for (i of placeholders; track i) {
          <div class="sk sk-card"></div>
        }
      </div>
    } @else {
      <div class="sk sk-block"></div>
      <div class="sk sk-block short"></div>
    }
  `,
  styles: `
    .loader { display: flex; align-items: center; justify-content: center; gap: 10px; padding: 16px; color: var(--muted); font-weight: 600; }
    .spinner { width: 22px; height: 22px; border: 3px solid var(--border); border-top-color: var(--primary); border-radius: 50%; animation: spin 0.8s linear infinite; }
    .sk { background: linear-gradient(90deg, var(--surface-2) 25%, var(--surface) 50%, var(--surface-2) 75%); background-size: 200% 100%; animation: shimmer 1.4s ease-in-out infinite; border-radius: var(--radius); border: 1px solid var(--border); }
    .sk-stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin-bottom: 16px; }
    .sk-stat { height: 70px; }
    .sk-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 10px; }
    .sk-card { height: 96px; }
    .sk-block { height: 160px; margin-bottom: 16px; }
    .sk-block.short { height: 90px; }
    @keyframes spin { to { transform: rotate(360deg); } }
    @keyframes shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }
    @media (prefers-reduced-motion: reduce) { .spinner, .sk { animation: none; } }
  `,
})
export class PageLoader {
  readonly message = input('Loading…');
  readonly variant = input<'cards' | 'detail'>('detail');
  protected readonly placeholders = Array.from({ length: 12 }, (_, i) => i);
}
