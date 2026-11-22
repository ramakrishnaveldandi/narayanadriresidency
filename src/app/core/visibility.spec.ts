import { TestBed } from '@angular/core/testing';
import { computed, signal } from '@angular/core';
import { AdminAuthService, decodeJwt } from './admin-auth.service';
import { DataService } from './data.service';

function jwt(payload: object): string {
  const b64 = (o: object) => btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${b64({ alg: 'RS256' })}.${b64(payload)}.sig`;
}

describe('decodeJwt', () => {
  it('reads the Google ID token payload', () => {
    expect(decodeJwt(jwt({ email: 'admin@example.com', aud: 'abc', exp: 1 }))).toMatchObject({ email: 'admin@example.com', aud: 'abc' });
    expect(decodeJwt('garbage')).toBeNull();
  });
});

describe('month visibility', () => {
  const admin = signal(false);
  const months = { months: [{ month: '2026-10', title: 'Oct' }, { month: '2026-11', title: 'Nov' }] };

  beforeEach(() => {
    admin.set(false);
    localStorage.clear();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const record = (m?: string) => ({ bill: { month: m, flats: [], columns: [] }, payments: [], audit: [] });
        // Static files (public/data)
        if (url.endsWith('index.json')) return new Response(JSON.stringify(months));
        const file = url.match(/(\d{4}-\d{2})\.json$/)?.[1];
        if (file) return new Response(JSON.stringify(record(file)));
        // Apps Script backend: GET ?action=… or POST {action: …}
        const params = init?.body ? JSON.parse(String(init.body)) : Object.fromEntries(new URL(url).searchParams);
        const data = params.action === 'index' ? months.months : record(params.month);
        return new Response(JSON.stringify({ ok: true, data }));
      }),
    );
    TestBed.configureTestingModule({
      providers: [
        {
          provide: AdminAuthService,
          useValue: { isAdmin: computed(() => admin()), actor: computed(() => 'x'), idToken: computed(() => ''), requireAdmin: () => undefined },
        },
      ],
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it('residents see only the latest month', async () => {
    const data = TestBed.inject(DataService);
    await data.loadIndex();
    expect(data.index().map((m) => m.month)).toEqual(['2026-11']);
    expect(data.resolveMonth('2026-10')).toBe('2026-11');
    expect(await data.getMonth('2026-10')).toBeNull();
    expect((await data.getMonth('2026-11'))?.bill.month).toBe('2026-11');
  });

  it('the admin sees every month', async () => {
    admin.set(true);
    const data = TestBed.inject(DataService);
    await data.loadIndex();
    expect(data.index().map((m) => m.month)).toEqual(['2026-11', '2026-10']);
    expect(data.resolveMonth('2026-10')).toBe('2026-10');
    expect((await data.getMonth('2026-10'))?.bill.month).toBe('2026-10');
  });
});
