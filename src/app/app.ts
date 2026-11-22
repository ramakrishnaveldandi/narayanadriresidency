import { Component, inject } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { APP_CONFIG } from './config/app-config';
import { AdminAuthService } from './core/admin-auth.service';
import { DataService } from './core/data.service';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, RouterLink, RouterLinkActive],
  template: `
    <header class="topbar">
      <div class="container bar">
        <a routerLink="/" class="brand">
          <span class="logo" aria-hidden="true">NR</span>
          <span>{{ name }}<small>Maintenance &amp; Payments</small></span>
        </a>
        <nav>
          <a routerLink="/" routerLinkActive="active" [routerLinkActiveOptions]="{ exact: true }">Dashboard</a>
          @if (auth.isAdmin()) {
            <a routerLink="/history" routerLinkActive="active">History</a>
          }
          <a routerLink="/admin" routerLinkActive="active">{{ auth.isAdmin() ? 'Admin' : 'Admin login' }}</a>
        </nav>
      </div>
    </header>
    @if (data.mode === 'static' && data.hasLocalChanges() && auth.isAdmin()) {
      <div class="container" style="padding-bottom:0">
        <div class="alert warn small">
          This browser holds admin changes that residents cannot see yet. Export them from
          <a routerLink="/admin/reports">Reports &amp; backup</a> and commit to <code>public/data/</code>.
        </div>
      </div>
    }
    <main class="container">
      <router-outlet />
    </main>
    <footer class="container muted small">
      Payments made through UPI are confirmed only after the association verifies them against bank records.
    </footer>
  `,
  styles: `
    .topbar { background: var(--primary); color: var(--primary-ink); }
    .bar { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; padding-top: 10px; padding-bottom: 10px; }
    .brand { display: flex; align-items: center; gap: 10px; color: inherit; text-decoration: none; font-weight: 700; margin-right: auto; }
    .brand small { display: block; font-weight: 500; opacity: 0.85; font-size: 0.75rem; }
    .logo { width: 36px; height: 36px; border-radius: 10px; background: var(--primary-ink); color: var(--primary); display: grid; place-items: center; font-size: 0.9rem; }
    nav { display: flex; gap: 4px; flex-wrap: wrap; }
    nav a { color: inherit; text-decoration: none; padding: 8px 12px; border-radius: 8px; font-weight: 600; opacity: 0.9; }
    nav a.active, nav a:hover { background: rgb(255 255 255 / 18%); opacity: 1; }
    footer { padding-bottom: 32px; }
  `,
})
export class App {
  protected readonly name = APP_CONFIG.apartmentName;
  protected readonly auth = inject(AdminAuthService);
  protected readonly data = inject(DataService);
}
