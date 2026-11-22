import { Routes } from '@angular/router';
import { adminGuard } from './pages/admin/admin.guard';

export const routes: Routes = [
  { path: '', loadComponent: () => import('./pages/dashboard').then((m) => m.Dashboard), title: 'Dashboard' },
  { path: 'flat/:flat', loadComponent: () => import('./pages/flat-detail').then((m) => m.FlatDetail), title: 'Flat details' },
  { path: 'pay/:flat', loadComponent: () => import('./pages/pay').then((m) => m.Pay), title: 'Pay maintenance' },
  { path: 'history', loadComponent: () => import('./pages/history').then((m) => m.History), title: 'Monthly history' },
  { path: 'admin/login', loadComponent: () => import('./pages/admin/admin-login').then((m) => m.AdminLogin), title: 'Admin login' },
  {
    path: 'admin',
    canActivate: [adminGuard],
    loadComponent: () => import('./pages/admin/admin-shell').then((m) => m.AdminShell),
    children: [
      { path: '', pathMatch: 'full', redirectTo: 'import' },
      { path: 'import', loadComponent: () => import('./pages/admin/admin-import').then((m) => m.AdminImport), title: 'Import month' },
      { path: 'payments', loadComponent: () => import('./pages/admin/admin-payments').then((m) => m.AdminPayments), title: 'Payments' },
      { path: 'reconcile', loadComponent: () => import('./pages/admin/admin-reconcile').then((m) => m.AdminReconcile), title: 'Reconcile' },
      { path: 'reports', loadComponent: () => import('./pages/admin/admin-reports').then((m) => m.AdminReports), title: 'Reports & backup' },
      { path: 'audit', loadComponent: () => import('./pages/admin/admin-audit').then((m) => m.AdminAudit), title: 'Audit trail' },
    ],
  },
  { path: '**', redirectTo: '' },
];
