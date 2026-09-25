/**
 * In-memory Supabase (GoTrue + PostgREST) mock for Playwright route interception.
 * Matches the subset of PostgREST the app uses: eq filters, order, select,
 * Prefer: return=representation, vnd.pgrst.object Accept, rpc.
 */
const crypto = require('crypto');

const USER_ID = '11111111-2222-3333-4444-555555555555';
const NOW = () => new Date().toISOString();

const USER = {
  id: USER_ID,
  aud: 'authenticated',
  role: 'authenticated',
  email: 'qa@example.com',
  user_metadata: { full_name: 'QA Tester', avatar_url: null },
  app_metadata: { provider: 'google' },
  created_at: '2026-01-01T00:00:00Z',
};

function fakeSession() {
  const payload = Buffer.from(JSON.stringify({
    sub: USER_ID, role: 'authenticated', exp: 2052464000, session_id: 'sess-1',
  })).toString('base64url');
  const token = `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.${payload}.fakesig`;
  return {
    access_token: token,
    token_type: 'bearer',
    expires_in: 3600 * 24 * 365,
    expires_at: 2052464000,
    refresh_token: 'fake-refresh-token',
    user: USER,
  };
}

function makeStore(seed = {}) {
  return {
    profiles: seed.profiles || [{
      id: USER_ID, display_name: 'QA Tester', avatar_url: null,
      default_visibility: 'private', created_at: NOW(), updated_at: NOW(),
    }],
    reviews: seed.reviews || [],
    watchlist: seed.watchlist || [],
    lists: seed.lists || [],
    list_items: seed.list_items || [],
  };
}

// parse PostgREST query string filters like user_id=eq.X&order=...&select=...
function matchFilters(row, searchParams) {
  for (const [key, val] of searchParams.entries()) {
    if (['select', 'order', 'limit', 'offset', 'on_conflict'].includes(key)) continue;
    if (val.startsWith('eq.')) {
      const want = val.slice(3);
      if (String(row[key]) !== want) return false;
    }
  }
  return true;
}

function applyOrder(rows, searchParams) {
  const order = searchParams.get('order');
  if (!order) return rows;
  const [col, dir] = order.split('.');
  return [...rows].sort((a, b) => {
    const av = a[col] ?? '', bv = b[col] ?? '';
    return (av < bv ? -1 : av > bv ? 1 : 0) * (dir === 'desc' ? -1 : 1);
  });
}

/**
 * Install route mocks on a Playwright context or page.
 * opts.failWrites: array of table names whose INSERT/PATCH return 500.
 * Returns { store, log } — log records every REST call for assertions.
 */
async function installSupabaseMock(target, opts = {}) {
  const store = makeStore(opts.seed);
  const log = [];
  const failWrites = new Set(opts.failWrites || []);

  await target.route('**://stub-supabase.local/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const method = req.method();
    const path = url.pathname;
    log.push({ method, path, qs: url.search, body: req.postData() });

    const json = (status, body) => route.fulfill({
      status,
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify(body),
    });

    if (method === 'OPTIONS') {
      return route.fulfill({
        status: 204,
        headers: {
          'access-control-allow-origin': '*',
          'access-control-allow-headers': '*',
          'access-control-allow-methods': '*',
        },
      });
    }

    // ---- GoTrue ----
    if (path.startsWith('/auth/v1/')) {
      if (path.endsWith('/user')) return json(200, USER);
      if (path.endsWith('/token')) return json(200, fakeSession());
      if (path.endsWith('/logout')) return json(204, {});
      return json(200, {});
    }

    // ---- PostgREST rpc ----
    if (path.startsWith('/rest/v1/rpc/')) {
      const fn = path.split('/').pop();
      if (fn === 'reorder_list_items') {
        const { p_item_ids, p_positions } = JSON.parse(req.postData() || '{}');
        p_item_ids.forEach((id, i) => {
          const item = store.list_items.find(r => r.id === id);
          if (item) item.position = p_positions[i];
        });
        return json(204, null);
      }
      return json(404, { message: `unknown rpc ${fn}` });
    }

    // ---- PostgREST tables ----
    if (path.startsWith('/rest/v1/')) {
      const table = path.split('/')[3];
      if (!store[table]) return json(404, { message: `unknown table ${table}` });
      const wantObject = (req.headers()['accept'] || '').includes('vnd.pgrst.object');

    if (method === 'GET') {
        let rows = store[table].filter(r => matchFilters(r, url.searchParams));
        rows = applyOrder(rows, url.searchParams);
        return json(200, wantObject ? (rows[0] ?? null) : rows);
      }

      if (method === 'POST') {
        if (failWrites.has(table)) return json(500, { message: 'Simulated server error', code: '500' });
        const body = JSON.parse(req.postData() || '{}');
        const rowsIn = Array.isArray(body) ? body : [body];
        const prefer = req.headers()['prefer'] || '';
        const out = [];
        for (const r of rowsIn) {
          if (prefer.includes('merge-duplicates') || prefer.includes('resolution')) {
            // upsert on id
            const existing = store[table].find(x => x.id === r.id);
            if (existing) { Object.assign(existing, r, { updated_at: NOW() }); out.push(existing); continue; }
          }
          const row = { id: crypto.randomUUID(), created_at: NOW(), updated_at: NOW(), ...r };
          store[table].push(row);
          out.push(row);
        }
        return json(201, wantObject ? out[0] : out);
      }

      if (method === 'PATCH') {
        if (failWrites.has(table)) return json(500, { message: 'Simulated server error', code: '500' });
        const updates = JSON.parse(req.postData() || '{}');
        const rows = store[table].filter(r => matchFilters(r, url.searchParams));
        rows.forEach(r => Object.assign(r, updates, { updated_at: NOW() }));
        return json(200, wantObject ? (rows[0] ?? null) : rows);
      }

      if (method === 'DELETE') {
        const doomed = store[table].filter(r => matchFilters(r, url.searchParams));
        store[table] = store[table].filter(r => !doomed.includes(r));
        return json(200, doomed);
      }
    }

    return json(404, { message: 'unmocked ' + path });
  });

  return { store, log, USER_ID };
}

/** Seed localStorage with a signed-in Supabase session before app scripts run. */
async function injectSession(context) {
  const session = fakeSession();
  await context.addInitScript((s) => {
    window.localStorage.setItem('bsc_auth', JSON.stringify(s));
  }, session);
}

module.exports = { installSupabaseMock, injectSession, USER_ID };
