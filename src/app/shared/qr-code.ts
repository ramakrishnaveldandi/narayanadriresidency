import { Component, effect, input, signal } from '@angular/core';

/** Renders any text (here: a UPI URI) as a QR code image, generated in the browser. */
@Component({
  selector: 'app-qr-code',
  template: `
    @if (src(); as s) {
      <img [src]="s" [width]="size()" [height]="size()" [alt]="alt()" />
    } @else {
      <div class="muted small" [style.width.px]="size()" [style.height.px]="size()">Generating QR…</div>
    }
  `,
  styles: `
    :host { display: inline-block; background: #fff; padding: 8px; border-radius: 8px; line-height: 0; }
    img { display: block; image-rendering: pixelated; }
  `,
})
export class QrCode {
  readonly value = input.required<string>();
  readonly size = input(240);
  readonly alt = input('UPI payment QR code');
  protected readonly src = signal<string | null>(null);

  constructor() {
    effect(() => {
      const text = this.value();
      const size = this.size();
      this.src.set(null);
      import('qrcode')
        .then((QR) => QR.toDataURL(text, { width: size * 2, margin: 1, errorCorrectionLevel: 'M' }))
        .then((url) => {
          if (text === this.value()) this.src.set(url);
        })
        .catch(() => this.src.set(null));
    });
  }
}
