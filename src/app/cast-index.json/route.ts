import { getCastIndexProfiles, splitCastIndex } from '@/lib/cast-index';

export const dynamic = 'force-static';

// Profiles below the /cast default filter, fetched lazily by CreativeIndexClient.
export function GET() {
  const { rest } = splitCastIndex(getCastIndexProfiles());
  return Response.json(rest);
}
