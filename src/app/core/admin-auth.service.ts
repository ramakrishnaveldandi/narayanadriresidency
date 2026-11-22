import { Injectable, computed, signal } from '@angular/core';
import { APP_CONFIG } from '../config/app-config';

interface Session {
  actor: string;
  key: string;
}

const SESSION_KEY = 'nrpay.admin.v1';

/**
 * Admin session. In API mode the key is checked by the Apps Script backend on
 * every write (the frontend never holds a secret). In static mode the
 * passphrase hash in APP_CONFIG is only a convenience gate.
 */
@Injectable({ providedIn: 'root' })
export class AdminAuthService {
  private readonly session = signal<Session | null>(this.restore());

  readonly isAdmin = computed(() => this.session() !== null);
  readonly actor = computed(() => this.session()?.actor ?? 'anonymous');
  readonly key = computed(() => this.session()?.key ?? '');

  async login(actor: string, passphrase: string): Promise<void> {
    const name = actor.trim() || 'admin';
    if (!passphrase) throw new Error('Enter the admin passphrase.');
    if (APP_CONFIG.apiUrl) {
      const res = await fetch(APP_CONFIG.apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ action: 'verifyKey', key: passphrase, actor: name }),
      });
      const json = (await res.json()) as { ok: boolean; error?: string };
      if (!json.ok) throw new Error(json.error ?? 'Invalid passphrase.');
    } else if ((await sha256Hex(passphrase)) !== APP_CONFIG.staticAdminPassphraseSha256) {
      throw new Error('Invalid passphrase.');
    }
    const s = { actor: name, key: APP_CONFIG.apiUrl ? passphrase : '' };
    this.session.set(s);
    try {
      sessionStorage.setItem(SESSION_KEY, JSON.stringify(s));
    } catch {
      /* storage unavailable: session lasts until reload */
    }
  }

  logout(): void {
    this.session.set(null);
    try {
      sessionStorage.removeItem(SESSION_KEY);
    } catch {
      /* ignore */
    }
  }

  requireAdmin(): void {
    if (!this.isAdmin()) throw new Error('Administrator login required.');
  }

  private restore(): Session | null {
    try {
      const raw = sessionStorage.getItem(SESSION_KEY);
      return raw ? (JSON.parse(raw) as Session) : null;
    } catch {
      return null;
    }
  }
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
