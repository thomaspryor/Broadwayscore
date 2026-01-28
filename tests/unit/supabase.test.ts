import { describe, test, expect, vi, beforeEach } from 'vitest';

// Mock @supabase/supabase-js so the import resolves without installing it
vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(),
}));

describe('getSupabaseClient', () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  });

  test('returns null when env vars are missing', async () => {
    // Mock window to exist (jsdom provides this)
    const { getSupabaseClient } = await import('@/lib/supabase');
    expect(getSupabaseClient()).toBeNull();
  });
});
