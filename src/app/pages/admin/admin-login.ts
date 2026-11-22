import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { AdminAuthService } from '../../core/admin-auth.service';
import { DataService } from '../../core/data.service';

@Component({
  selector: 'app-admin-login',
  imports: [FormsModule],
  template: `
    <div class="card" style="max-width:420px;margin:24px auto">
      <h1>Administrator login</h1>
      <form class="stack" (ngSubmit)="submit()">
        <label class="field">Your name (for the audit trail) <input name="actor" [(ngModel)]="actor" autocomplete="name" /></label>
        <label class="field">Passphrase <input name="pass" type="password" [(ngModel)]="pass" autocomplete="current-password" required /></label>
        @if (error()) {
          <div class="alert error small">{{ error() }}</div>
        }
        <button class="btn primary" type="submit" [disabled]="busy()">Log in</button>
      </form>
      @if (mode === 'static') {
        <p class="small muted">
          Static mode: admin changes stay in this browser until you export them and commit them to the repository.
          Connect the Apps Script backend for shared, server-protected admin access.
        </p>
      }
    </div>
  `,
})
export class AdminLogin {
  private readonly auth = inject(AdminAuthService);
  private readonly router = inject(Router);
  protected readonly mode = inject(DataService).mode;
  protected readonly error = signal('');
  protected readonly busy = signal(false);
  protected actor = '';
  protected pass = '';

  async submit(): Promise<void> {
    this.busy.set(true);
    this.error.set('');
    try {
      await this.auth.login(this.actor, this.pass);
      await this.router.navigate(['/admin']);
    } catch (e) {
      this.error.set((e as Error).message);
    } finally {
      this.busy.set(false);
    }
  }
}
