import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { AdminAuthService } from '../../core/admin-auth.service';

export const adminGuard: CanActivateFn = () => {
  return inject(AdminAuthService).isAdmin() || inject(Router).createUrlTree(['/admin/login']);
};
