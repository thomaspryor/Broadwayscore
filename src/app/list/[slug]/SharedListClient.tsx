'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { getSupabaseClient } from '@/lib/supabase';
import { ScoreBadge } from '@/components/show-cards';
import { getOptimizedImageUrl } from '@/lib/images';

interface ListData {
  id: string;
  name: string;
  description: string | null;
  is_ranked: boolean;
  is_public: boolean;
  user_id: string;
}

interface ListItemData {
  show_id: string;
  position: number;
  note: string | null;
}

interface ProfileData {
  display_name: string;
  avatar_url: string | null;
}

interface ShowInfo {
  id: string;
  title: string;
  slug: string;
  venue: string;
  posterUrl: string | null;
  status: string;
  score: number | null;
  reviewCount: number;
  category: string;
}

// Decode show-lookup.json format
function decodeShowLookup(raw: Record<string, unknown>): Omit<ShowInfo, 'score' | 'reviewCount'> {
  return {
    id: raw.id as string,
    title: raw.t as string,
    slug: raw.s as string,
    venue: raw.v as string,
    posterUrl: (raw.p as string) || null,
    status: (raw.st as string) || 'closed',
    category: (raw.c as string) || 'broadway',
  };
}

export default function SharedListClient({ slug }: { slug: string }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [list, setList] = useState<ListData | null>(null);
  const [items, setItems] = useState<ListItemData[]>([]);
  const [profile, setProfile] = useState<ProfileData | null>(null);
  const [shows, setShows] = useState<Map<string, ShowInfo>>(new Map());

  useEffect(() => {
    let cancelled = false;

    async function loadList() {
      const client = getSupabaseClient();
      if (!client) {
        setError('Unable to load list data.');
        setLoading(false);
        return;
      }

      try {
        // Fetch list by share_slug
        const { data: listData, error: listErr } = await client
          .from('lists')
          .select('id, name, description, is_ranked, is_public, user_id')
          .eq('share_slug', slug)
          .eq('is_public', true)
          .single();

        if (listErr || !listData) {
          if (cancelled) return;
          setError('private');
          setLoading(false);
          return;
        }

        // Fetch profile + items in parallel
        const [profileRes, itemsRes] = await Promise.all([
          client
            .from('profiles')
            .select('display_name, avatar_url')
            .eq('id', listData.user_id)
            .single(),
          client
            .from('list_items')
            .select('show_id, position, note')
            .eq('list_id', listData.id)
            .order('position', { ascending: true })
            .limit(200),
        ]);

        if (cancelled) return;

        setList(listData);
        setProfile(profileRes.data || { display_name: 'Anonymous', avatar_url: null });
        setItems(itemsRes.data || []);

        // Fetch show data
        const showIds = (itemsRes.data || []).map((i: ListItemData) => i.show_id);
        if (showIds.length > 0) {
          await loadShowData(showIds, cancelled);
        }
      } catch {
        if (!cancelled) setError('Failed to load list.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    async function loadShowData(showIds: string[], isCancelled: boolean) {
      // Step 1: Fetch show-lookup.json for basic info
      const lookupMap = new Map<string, Omit<ShowInfo, 'score' | 'reviewCount'>>();
      try {
        const res = await fetch('/data/show-lookup.json');
        const allShows: Record<string, unknown>[] = await res.json();
        const idSet = new Set(showIds);
        for (const raw of allShows) {
          if (idSet.has(raw.id as string)) {
            lookupMap.set(raw.id as string, decodeShowLookup(raw));
          }
        }
      } catch { /* continue without lookup data */ }

      if (isCancelled) return;

      // Step 2: Fetch individual show JSONs for scores (parallel, max 200)
      const showMap = new Map<string, ShowInfo>();
      const fetchPromises = showIds.map(async (id) => {
        const base = lookupMap.get(id);
        try {
          const res = await fetch(`/data/shows/${id}.json`);
          if (!res.ok) throw new Error('not found');
          const data = await res.json();

          showMap.set(id, {
            id,
            title: base?.title || id,
            slug: base?.slug || id,
            venue: base?.venue || '',
            posterUrl: base?.posterUrl || (data.hi ? data.hi : null),
            status: base?.status || 'closed',
            score: data.cs ?? null,
            reviewCount: data.rc ?? 0,
            category: base?.category || 'broadway',
          });
        } catch {
          // Use lookup data without score
          if (base) {
            showMap.set(id, { ...base, score: null, reviewCount: 0 });
          }
        }
      });

      await Promise.allSettled(fetchPromises);
      if (!isCancelled) setShows(showMap);
    }

    loadList();
    return () => { cancelled = true; };
  }, [slug]);

  // --- Error states ---
  if (error === 'private') {
    return (
      <div className="min-h-screen bg-[#0a0a0a] flex items-center justify-center px-4">
        <div className="text-center max-w-sm">
          <div className="text-5xl mb-4">🔒</div>
          <h1 className="text-xl font-bold text-white mb-2">This list is private</h1>
          <p className="text-sm text-gray-400 mb-6">The owner may have made this list private, or the link may be incorrect.</p>
          <Link href="/" className="text-sm text-brand hover:text-brand/80 transition-colors">
            Go to Broadway Scorecard
          </Link>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen bg-[#0a0a0a] flex items-center justify-center px-4">
        <div className="text-center max-w-sm">
          <div className="text-5xl mb-4">😕</div>
          <h1 className="text-xl font-bold text-white mb-2">Something went wrong</h1>
          <p className="text-sm text-gray-400 mb-6">{error}</p>
          <Link href="/" className="text-sm text-brand hover:text-brand/80 transition-colors">
            Go to Broadway Scorecard
          </Link>
        </div>
      </div>
    );
  }

  // --- Loading state ---
  if (loading || !list) {
    return (
      <div className="min-h-screen bg-[#0a0a0a] px-4 py-8">
        <div className="max-w-2xl mx-auto">
          <div className="h-8 w-48 bg-white/5 rounded-lg animate-pulse mb-2" />
          <div className="h-4 w-32 bg-white/5 rounded animate-pulse mb-6" />
          <div className="space-y-3">
            {[1, 2, 3, 4, 5].map(i => (
              <div key={i} className="h-20 bg-white/5 rounded-xl animate-pulse" />
            ))}
          </div>
        </div>
      </div>
    );
  }

  // --- Main view ---
  return (
    <div className="min-h-screen bg-[#0a0a0a] px-4 py-8">
      <div className="max-w-2xl mx-auto">
        {/* Header */}
        <div className="mb-6">
          <h1 className="text-2xl sm:text-3xl font-extrabold text-white mb-1">{list.name}</h1>
          {profile && (
            <p className="text-sm text-gray-400">
              by {profile.display_name || 'Anonymous'}
              {list.is_ranked && (
                <span className="ml-2 text-[10px] font-semibold text-amber-400/70 bg-amber-400/10 px-1.5 py-0.5 rounded">
                  Ranked
                </span>
              )}
            </p>
          )}
          {list.description && (
            <p className="text-sm text-gray-400 mt-2">{list.description}</p>
          )}
          <p className="text-xs text-gray-600 mt-1">
            {items.length} {items.length === 1 ? 'show' : 'shows'}
          </p>
        </div>

        {/* List items */}
        {items.length === 0 ? (
          <div className="text-center py-16">
            <div className="text-4xl mb-3">🎭</div>
            <p className="text-sm text-gray-400">This list is empty.</p>
          </div>
        ) : (
          <div className="space-y-1.5">
            {items.map((item, index) => {
              const show = shows.get(item.show_id);
              return (
                <SharedListItem
                  key={item.show_id}
                  item={item}
                  index={index}
                  show={show}
                  isRanked={list.is_ranked}
                />
              );
            })}
          </div>
        )}

        {/* CTA */}
        <div className="mt-10 pt-6 border-t border-white/[0.06] text-center">
          <p className="text-sm text-gray-400 mb-3">Want to make your own list?</p>
          <Link
            href="/my-shows?tab=lists"
            className="btn-primary text-sm"
          >
            Create your own list
          </Link>
          <p className="text-[11px] text-gray-600 mt-4">
            Powered by{' '}
            <Link href="/" className="text-brand hover:text-brand/80 transition-colors">
              Broadway Scorecard
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}

// --- Shared List Item ---

function SharedListItem({
  item, index, show, isRanked,
}: {
  item: ListItemData;
  index: number;
  show: ShowInfo | undefined;
  isRanked: boolean;
}) {
  const title = show?.title || item.show_id;
  const href = show ? `/show/${show.slug}` : '#';
  const posterSrc = show?.posterUrl
    ? (show.posterUrl.startsWith('/') ? show.posterUrl : getOptimizedImageUrl(show.posterUrl, 'thumbnail'))
    : null;

  return (
    <Link
      href={href}
      className="group flex items-center gap-3 px-3 sm:px-4 py-3 rounded-xl bg-white/[0.02] border border-white/[0.06] hover:border-white/10 hover:bg-white/[0.04] transition-colors"
    >
      {/* Rank number */}
      {isRanked && (
        <span className="flex-shrink-0 w-7 text-center text-lg font-bold text-gray-500">
          {index + 1}
        </span>
      )}

      {/* Poster */}
      <div className="flex-shrink-0 w-12 sm:w-14 aspect-[2/3] rounded-lg overflow-hidden bg-white/[0.04]">
        {posterSrc ? (
          <img src={posterSrc} alt={title} className="w-full h-full object-cover" loading="lazy" />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-gray-600 text-lg">🎭</div>
        )}
      </div>

      {/* Info */}
      <div className="flex-1 min-w-0">
        <h3 className="font-bold text-white text-sm sm:text-base group-hover:text-brand transition-colors truncate">
          {title}
        </h3>
        {show?.venue && (
          <p className="text-xs text-gray-500 truncate">{show.venue}</p>
        )}
        {item.note && (
          <p className="text-xs text-gray-400 mt-1 line-clamp-2 italic">&ldquo;{item.note}&rdquo;</p>
        )}
      </div>

      {/* Score */}
      {show && (
        <div className="flex-shrink-0">
          <ScoreBadge
            score={show.score}
            size="sm"
            reviewCount={show.reviewCount}
            status={show.status}
            category={show.category}
          />
        </div>
      )}

      {/* Chevron */}
      <svg className="w-4 h-4 text-gray-600 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
      </svg>
    </Link>
  );
}
