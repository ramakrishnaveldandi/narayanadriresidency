import { AfterViewInit, Component, ElementRef, inject, signal, viewChild } from '@angular/core';
import { Router } from '@angular/router';
import { AdminAuthService } from '../../core/admin-auth.service';
import { DataService } from '../../core/data.service';

@Component({
  selector: 'app-admin-login',
  template: `
    <div class="card stack" style="max-width:440px;margin:24px auto;text-align:center">
      <h1>Administrator sign-in</h1>
      <p class="muted" style="margin:0">
        Only the association's administrator Google account can sign in.
      </p>
      @if (auth.configured) {
        <div class="gsi">
          <div #gsiButton></div>
          <span>Sign in with Google</span>
        </div>
      } @else {
        <div class="alert warn small" style="text-align:left">
          Google sign-in is not set up yet. Add the OAuth client ID to <code>admin.googleClientId</code> in
          <code>src/app/config/app-config.ts</code> (see README → Admin sign-in).
        </div>
      }
      @if (error()) {
        <div class="alert error small" style="text-align:left">{{ error() }}</div>
      }
    </div>
  `,
  styles: `.gsi { display: flex; justify-content: center; align-items: center; gap: 10px; min-height: 44px; font-weight: 600; }`,
})
export class AdminLogin implements AfterViewInit {
  protected readonly auth = inject(AdminAuthService);
  private readonly data = inject(DataService);
  private readonly router = inject(Router);
  private readonly button = viewChild<ElementRef<HTMLElement>>('gsiButton');
  protected readonly error = signal('');

  ngAfterViewInit(): void {
    if (this.auth.isAdmin()) {
      void this.router.navigate(['/admin']);
      return;
    }
    const el = this.button()?.nativeElement;
    if (!el) return;
    this.auth
      .renderSignInButton(el, async (err) => {
        if (err) return this.error.set(err);
        this.error.set('');
        await this.data.refreshForSession();
        await this.router.navigate(['/admin']);
      })
      .catch((e: Error) => this.error.set(e.message));
  }
}
