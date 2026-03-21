import type { Metadata } from 'next';
import { getServerSupabaseClient } from '@/lib/supabase-server';
import { BASE_URL } from '@/lib/seo';
import SharedListClient from './SharedListClient';

interface PageProps {
  params: Promise<{ slug: string }>;
}

async function getListData(slug: string) {
  const client = getServerSupabaseClient();
  if (!client) return null;

  const { data: list } = await client
    .from('lists')
    .select('id, name, description, is_ranked, is_public, user_id')
    .eq('share_slug', slug)
    .eq('is_public', true)
    .single();

  if (!list) return null;

  const { data: profile } = await client
    .from('profiles')
    .select('display_name, avatar_url')
    .eq('id', list.user_id)
    .single();

  const { data: items } = await client
    .from('list_items')
    .select('show_id, note')
    .eq('list_id', list.id)
    .order('position', { ascending: true })
    .limit(200);

  return {
    list,
    profile: profile || { display_name: 'Anonymous', avatar_url: null },
    showIds: (items || []).map((i: { show_id: string }) => i.show_id),
    showTitles: [], // populated below if items exist
  };
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const data = await getListData(slug);

  if (!data) {
    return { title: 'List Not Found — Broadway Scorecard' };
  }

  const { list, profile, showIds } = data;
  const count = showIds.length;
  const byLine = profile.display_name ? ` by ${profile.display_name}` : '';
  const title = `${list.name}${byLine}`;
  const description = list.description
    || `${count} show${count !== 1 ? 's' : ''} ${list.is_ranked ? 'ranked' : 'curated'} on Broadway Scorecard`;

  return {
    title: `${title} — Broadway Scorecard`,
    description,
    openGraph: {
      title,
      description,
      url: `${BASE_URL}/list/${slug}`,
      type: 'article',
      images: [`${BASE_URL}/api/og?type=list&title=${encodeURIComponent(list.name)}&count=${count}&creator=${encodeURIComponent(profile.display_name || '')}`],
    },
    twitter: {
      card: 'summary_large_image',
      title,
      description,
    },
  };
}

export default async function SharedListPage({ params }: PageProps) {
  const { slug } = await params;
  return <SharedListClient slug={slug} />;
}
