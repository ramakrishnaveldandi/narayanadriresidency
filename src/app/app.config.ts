import { ApplicationConfig, provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideRouter, withComponentInputBinding, withHashLocation } from '@angular/router';
import { routes } from './app.routes';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    // Hash URLs (#/flat/101) work on GitHub Pages without 404 rewrites.
    provideRouter(routes, withHashLocation(), withComponentInputBinding()),
  ],
};
