import { Component, inject } from '@angular/core';
import { Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { AdminAuthService } from '../../core/admin-auth.service';
import { DataService } from '../../core/data.service';

@Component({
  selector: 'app-admin-shell',
  imports: [RouterOutlet, RouterLink, RouterLinkActive],
  template: `
    <div class="row" style="margin-bottom:8px">
      <h1 class="spacer">Administration</h1>
      <span class="badge info">{{ data.mode === 'api' ? 'Apps Script backend' : 'Static mode' }}</span>
      <span class="small muted">Signed in as {{ auth.actor() }}</span>
      <button class="btn sm" type="button" (click)="logout()">Log out</button>
    </div>
    <nav class="tabs">
      <a routerLink="import" routerLinkActive="active">Import month</a>
      <a routerLink="payments" routerLinkActive="active">Payments</a>
      <a routerLink="reconcile" routerLinkActive="active">Reconcile</a>
      <a routerLink="reports" routerLinkActive="active">Reports &amp; backup</a>
      <a routerLink="audit" routerLinkActive="active">Audit trail</a>
    </nav>
    <router-outlet />
  `,
})
export class AdminShell {
  protected readonly auth = inject(AdminAuthService);
  protected readonly data = inject(DataService);
  private readonly router = inject(Router);

  logout(): void {
    this.auth.logout();
    void this.router.navigate(['/']);
  }
}
