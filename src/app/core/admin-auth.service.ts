import { Injectable, computed, signal } from '@angular/core';
import { APP_CONFIG } from '../config/app-config';

interface Session {
  email: string;
  name: string;
  /** Google ID token (JWT). Sent to the Apps Script backend, which verifies it with Google. */
  idToken: string;
  /** Token expiry, epoch milliseconds. */
  exp: number;
}

interface GoogleIdPayload {
  email?: string;
  email_verified?: boolean;
  name?: string;
  aud?: string;
  iss?: string;
  exp?: number;
}

/** Minimal typing for Google Identity Services (accounts.google.com/gsi/client). */
interface GoogleAccountsId {
  initialize(cfg: { client_id: string; callback: (r: { credential: string }) => void; auto_select?: boolean; ux_mode?: 'popup' }): void;
  renderButton(el: HTMLElement, opts: Record<string, unknown>): void;
  disableAutoSelect(): void;
}
declare global {
  interface Window {
    google?: { accounts: { id: GoogleAccountsId } };
  }
}

const SESSION_KEY = 'nrpay.admin.google.v1';
const GSI_SRC = 'https://accounts.google.com/gsi/client';

/**
 * Administrator session via "Sign in with Google". Only APP_CONFIG.admin.allowedEmail
 * is accepted.
 *
 * - API mode: the Apps Script backend verifies the ID token with Google and checks
 *   the email on every admin request, so this is enforced server-side.
 * - Static mode: the check happens in the browser. That hides admin screens and
 *   older months from residents, but a static site cannot truly secure files.
 */
@Injectable({ providedIn: 'root' })
export class AdminAuthService {
  private readonly session = signal<Session | null>(this.restore());
  private gsiLoaded?: Promise<GoogleAccountsId>;

  readonly isAdmin = computed(() => {
    const s = this.session();
    return !!s && s.exp > Date.now();
  });
  readonly actor = computed(() => this.session()?.email ?? 'anonymous');
  readonly name = computed(() => this.session()?.name ?? '');
  readonly idToken = computed(() => (this.isAdmin() ? this.session()!.idToken : ''));
  readonly allowedEmail = APP_CONFIG.admin.allowedEmail;
  readonly configured = !!APP_CONFIG.admin.googleClientId;

  /** Renders the Google button into `el`. Resolves after a successful sign-in; rejects on a wrong account. */
  async renderSignInButton(el: HTMLElement, onResult: (error: string | null) => void): Promise<void> {
    if (!this.configured) throw new Error('Google sign-in is not configured (APP_CONFIG.admin.googleClientId).');
    const gsi = await this.loadGsi();
    gsi.initialize({
      client_id: APP_CONFIG.admin.googleClientId,
      ux_mode: 'popup',
      callback: ({ credential }) => onResult(this.acceptCredential(credential)),
    });
    gsi.renderButton(el, { type: 'standard', theme: 'filled_blue', size: 'large', text: 'signin_with', shape: 'pill' });
  }

  logout(): void {
    this.session.set(null);
    try {
      sessionStorage.removeItem(SESSION_KEY);
    } catch {
      /* ignore */
    }
    window.google?.accounts.id.disableAutoSelect();
  }

  requireAdmin(): void {
    if (!this.isAdmin()) {
      if (this.session()) this.logout();
      throw new Error('Administrator sign-in required (your session may have expired - please sign in again).');
    }
  }

  /** Returns an error message, or null when the credential belongs to the allowed admin account. */
  private acceptCredential(credential: string): string | null {
    const p = decodeJwt(credential);
    if (!p) return 'Could not read the Google sign-in response.';
    const email = (p.email ?? '').toLowerCase();
    if (p.aud !== APP_CONFIG.admin.googleClientId) return 'Sign-in was issued for a different application.';
    if (!p.email_verified) return 'This Google account email is not verified.';
    if (email !== this.allowedEmail.toLowerCase()) {
      window.google?.accounts.id.disableAutoSelect();
      return `${p.email} is not the administrator account. Only ${this.allowedEmail} can sign in.`;
    }
    const s: Session = { email, name: p.name ?? email, idToken: credential, exp: (p.exp ?? 0) * 1000 };
    this.session.set(s);
    try {
      sessionStorage.setItem(SESSION_KEY, JSON.stringify(s));
    } catch {
      /* storage unavailable: session lasts until reload */
    }
    return null;
  }

  private loadGsi(): Promise<GoogleAccountsId> {
    this.gsiLoaded ??= new Promise((resolve, reject) => {
      if (window.google?.accounts?.id) return resolve(window.google.accounts.id);
      const s = document.createElement('script');
      s.src = GSI_SRC;
      s.async = true;
      s.onload = () => (window.google?.accounts?.id ? resolve(window.google.accounts.id) : reject(new Error('Google sign-in failed to load.')));
      s.onerror = () => {
        this.gsiLoaded = undefined;
        reject(new Error('Could not load Google sign-in. Check your connection or ad-blocker.'));
      };
      document.head.appendChild(s);
    });
    return this.gsiLoaded;
  }

  private restore(): Session | null {
    try {
      const raw = sessionStorage.getItem(SESSION_KEY);
      const s = raw ? (JSON.parse(raw) as Session) : null;
      return s && s.exp > Date.now() && s.email === APP_CONFIG.admin.allowedEmail.toLowerCase() ? s : null;
    } catch {
      return null;
    }
  }
}

export function decodeJwt(token: string): GoogleIdPayload | null {
  try {
    const part = token.split('.')[1];
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(part.length / 4) * 4, '=');
    const json = decodeURIComponent(
      atob(b64)
        .split('')
        .map((c) => '%' + c.charCodeAt(0).toString(16).padStart(2, '0'))
        .join(''),
    );
    return JSON.parse(json) as GoogleIdPayload;
  } catch {
    return null;
  }
}
