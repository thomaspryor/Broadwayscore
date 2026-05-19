/**
 * Mock data for dev-mode visual QA.
 * Activated by ?mock=1 on localhost only.
 * Never imported in production builds — guarded by runtime check in MyShowsClient.
 */
import type { UserReview, WatchlistEntry, ShowLookup, UserList, ListItem } from '@/types/user';

const USER_ID = 'mock-user-000';

// Mix of shows with varied titles, ratings, dates to test edge cases
export const mockReviews: UserReview[] = [
  {
    id: 'r1', user_id: USER_ID, show_id: 'wicked-2003',
    rating: 4.5, review_text: 'Incredible production, Elphaba was phenomenal.', date_seen: '2025-12-15',
    visibility: 'private', created_at: '2025-12-16T00:00:00Z', updated_at: '2025-12-16T00:00:00Z',
  },
  {
    id: 'r2', user_id: USER_ID, show_id: 'hamilton-2015',
    rating: 5.0, review_text: null, date_seen: '2025-11-20',
    visibility: 'private', created_at: '2025-11-21T00:00:00Z', updated_at: '2025-11-21T00:00:00Z',
  },
  {
    id: 'r3', user_id: USER_ID, show_id: 'cabaret-2024',
    rating: 3.5, review_text: 'Good but not great revival.', date_seen: '2025-10-05',
    visibility: 'private', created_at: '2025-10-06T00:00:00Z', updated_at: '2025-10-06T00:00:00Z',
  },
  {
    id: 'r4', user_id: USER_ID, show_id: 'sunset-boulevard-2024',
    rating: 4.0, review_text: null, date_seen: null,
    visibility: 'private', created_at: '2025-09-15T00:00:00Z', updated_at: '2025-09-15T00:00:00Z',
  },
  {
    id: 'r5', user_id: USER_ID, show_id: 'merrily-we-roll-along-2023',
    rating: 5.0, review_text: 'Best revival I have ever seen. Daniel Radcliffe and Jonathan Groff were extraordinary.', date_seen: '2024-06-10',
    visibility: 'private', created_at: '2024-06-11T00:00:00Z', updated_at: '2024-06-11T00:00:00Z',
  },
  {
    id: 'r6', user_id: USER_ID, show_id: 'book-of-mormon-2011',
    rating: 4.0, review_text: null, date_seen: '2024-03-22',
    visibility: 'private', created_at: '2024-03-23T00:00:00Z', updated_at: '2024-03-23T00:00:00Z',
  },
  {
    id: 'r7', user_id: USER_ID, show_id: 'death-becomes-her-2024',
    rating: 2.5, review_text: 'Disappointing.', date_seen: '2025-01-18',
    visibility: 'private', created_at: '2025-01-19T00:00:00Z', updated_at: '2025-01-19T00:00:00Z',
  },
  // Diary-only shows (no show page, no link)
  {
    id: 'r8', user_id: USER_ID, show_id: 'rent-off-broadway-1996',
    rating: 5.0, review_text: 'Changed my life.', date_seen: '1996-04-29',
    visibility: 'private', created_at: '2024-01-01T00:00:00Z', updated_at: '2024-01-01T00:00:00Z',
  },
  {
    id: 'r9', user_id: USER_ID, show_id: 'les-miserables-west-end-1985',
    rating: 4.5, review_text: null, date_seen: '2019-08-10',
    visibility: 'private', created_at: '2024-01-02T00:00:00Z', updated_at: '2024-01-02T00:00:00Z',
  },
];

export const mockWatchlist: WatchlistEntry[] = [
  { id: 'w1', user_id: USER_ID, show_id: 'gypsy-2024', planned_date: '2026-09-15', created_at: '2026-01-01T00:00:00Z' },
  { id: 'w2', user_id: USER_ID, show_id: 'smash-2025', planned_date: '2026-10-10', created_at: '2026-02-01T00:00:00Z' },
  { id: 'w3', user_id: USER_ID, show_id: 'oh-mary-2024', planned_date: null, created_at: '2025-12-15T00:00:00Z' },
  { id: 'w4', user_id: USER_ID, show_id: 'operation-mincemeat-2025', planned_date: null, created_at: '2026-01-20T00:00:00Z' },
  // Past planned_date, no review → "To be rated"
  { id: 'w5', user_id: USER_ID, show_id: 'chess-2025', planned_date: '2026-02-15', created_at: '2026-01-05T00:00:00Z' },
  { id: 'w6', user_id: USER_ID, show_id: 'ragtime-2025', planned_date: '2026-02-28', created_at: '2026-01-10T00:00:00Z' },
];

// Mock lists for the Lists tab
export const mockLists: UserList[] = [
  {
    id: 'list-1', user_id: USER_ID, name: 'Must-See Musicals',
    description: 'My all-time favorites that everyone should see.',
    is_ranked: true, is_public: true, share_slug: 'abc12345',
    created_at: '2026-01-15T00:00:00Z', updated_at: '2026-03-01T00:00:00Z',
    item_count: 4, preview_show_ids: ['hamilton-2015', 'wicked-2003', 'merrily-we-roll-along-2023', 'book-of-mormon-2011'],
    all_show_ids: ['hamilton-2015', 'wicked-2003', 'merrily-we-roll-along-2023', 'book-of-mormon-2011'],
  },
  {
    id: 'list-2', user_id: USER_ID, name: 'Shows to Revisit',
    description: null,
    is_ranked: false, is_public: false, share_slug: null,
    created_at: '2026-02-10T00:00:00Z', updated_at: '2026-02-20T00:00:00Z',
    item_count: 2, preview_show_ids: ['cabaret-2024', 'sunset-boulevard-2024'],
    all_show_ids: ['cabaret-2024', 'sunset-boulevard-2024'],
  },
  {
    id: 'list-3', user_id: USER_ID, name: '2025 Season Picks',
    description: 'What I want to catch this season.',
    is_ranked: false, is_public: false, share_slug: null,
    created_at: '2025-09-01T00:00:00Z', updated_at: '2026-01-05T00:00:00Z',
    item_count: 3, preview_show_ids: ['gypsy-2024', 'smash-2025', 'operation-mincemeat-2025'],
    all_show_ids: ['gypsy-2024', 'smash-2025', 'operation-mincemeat-2025'],
  },
];

export const mockListItems: Record<string, ListItem[]> = {
  'list-1': [
    { id: 'li-1', list_id: 'list-1', show_id: 'hamilton-2015', position: 1000, note: null, created_at: '2026-01-15T00:00:00Z' },
    { id: 'li-2', list_id: 'list-1', show_id: 'wicked-2003', position: 2000, note: null, created_at: '2026-01-15T00:00:00Z' },
    { id: 'li-3', list_id: 'list-1', show_id: 'merrily-we-roll-along-2023', position: 3000, note: null, created_at: '2026-01-20T00:00:00Z' },
    { id: 'li-4', list_id: 'list-1', show_id: 'book-of-mormon-2011', position: 4000, note: null, created_at: '2026-02-01T00:00:00Z' },
  ],
  'list-2': [
    { id: 'li-5', list_id: 'list-2', show_id: 'cabaret-2024', position: 1000, note: null, created_at: '2026-02-10T00:00:00Z' },
    { id: 'li-6', list_id: 'list-2', show_id: 'sunset-boulevard-2024', position: 2000, note: null, created_at: '2026-02-10T00:00:00Z' },
  ],
  'list-3': [
    { id: 'li-7', list_id: 'list-3', show_id: 'gypsy-2024', position: 1000, note: null, created_at: '2025-09-01T00:00:00Z' },
    { id: 'li-8', list_id: 'list-3', show_id: 'smash-2025', position: 2000, note: null, created_at: '2025-09-15T00:00:00Z' },
    { id: 'li-9', list_id: 'list-3', show_id: 'operation-mincemeat-2025', position: 3000, note: null, created_at: '2025-10-01T00:00:00Z' },
  ],
};

// Minimal show lookup entries matching the IDs above
export const mockShowMap: Record<string, ShowLookup> = {
  'wicked-2003': { id: 'wicked-2003', title: 'Wicked', slug: 'wicked-2003', venue: 'Gershwin Theatre', type: 'musical', status: 'open', category: 'broadway', previewDate: null, openingDate: '2003-10-30', closingDate: null, compositeScore: 86, posterUrl: null },
  'hamilton-2015': { id: 'hamilton-2015', title: 'Hamilton', slug: 'hamilton-2015', venue: 'Richard Rodgers Theatre', type: 'musical', status: 'open', category: 'broadway', previewDate: null, openingDate: '2015-08-06', closingDate: null, compositeScore: 97, posterUrl: null },
  'cabaret-2024': { id: 'cabaret-2024', title: 'Cabaret at the Kit Kat Club', slug: 'cabaret-2024', venue: 'August Wilson Theatre', type: 'musical', status: 'open', category: 'broadway', previewDate: null, openingDate: '2024-04-21', closingDate: '2026-07-06', compositeScore: 88, posterUrl: null },
  'sunset-boulevard-2024': { id: 'sunset-boulevard-2024', title: 'Sunset Boulevard', slug: 'sunset-boulevard-2024', venue: 'St. James Theatre', type: 'musical', status: 'closed', category: 'broadway', previewDate: null, openingDate: '2024-10-20', closingDate: '2025-07-20', compositeScore: 82, posterUrl: null },
  'merrily-we-roll-along-2023': { id: 'merrily-we-roll-along-2023', title: 'Merrily We Roll Along', slug: 'merrily-we-roll-along-2023', venue: 'Hudson Theatre', type: 'musical', status: 'closed', category: 'broadway', previewDate: null, openingDate: '2023-10-12', closingDate: '2024-07-07', compositeScore: 91, posterUrl: null },
  'book-of-mormon-2011': { id: 'book-of-mormon-2011', title: 'The Book of Mormon', slug: 'book-of-mormon-2011', venue: 'Eugene O\'Neill Theatre', type: 'musical', status: 'closed', category: 'broadway', previewDate: null, openingDate: '2011-03-24', closingDate: '2025-04-13', compositeScore: 93, posterUrl: null },
  'death-becomes-her-2024': { id: 'death-becomes-her-2024', title: 'Death Becomes Her', slug: 'death-becomes-her-2024', venue: 'Lunt-Fontanne Theatre', type: 'musical', status: 'open', category: 'broadway', previewDate: null, openingDate: '2024-11-21', closingDate: null, compositeScore: 62, posterUrl: null },
  'gypsy-2024': { id: 'gypsy-2024', title: 'Gypsy', slug: 'gypsy-2024', venue: 'Majestic Theatre', type: 'musical', status: 'open', category: 'broadway', previewDate: null, openingDate: '2024-12-19', closingDate: null, compositeScore: 95, posterUrl: null },
  'smash-2025': { id: 'smash-2025', title: 'Smash', slug: 'smash-2025', venue: 'Imperial Theatre', type: 'musical', status: 'open', category: 'broadway', previewDate: null, openingDate: '2025-04-23', closingDate: null, compositeScore: 51, posterUrl: null },
  'oh-mary-2024': { id: 'oh-mary-2024', title: 'Oh, Mary!', slug: 'oh-mary-2024', venue: 'Lyceum Theatre', type: 'play', status: 'open', category: 'broadway', previewDate: null, openingDate: '2024-07-11', closingDate: null, compositeScore: 80, posterUrl: null },
  'operation-mincemeat-2025': { id: 'operation-mincemeat-2025', title: 'Operation Mincemeat', slug: 'operation-mincemeat-2025', venue: 'Golden Theatre', type: 'musical', status: 'open', category: 'broadway', previewDate: null, openingDate: '2025-03-20', closingDate: null, compositeScore: 85, posterUrl: null },
  'chess-2025': { id: 'chess-2025', title: 'Chess', slug: 'chess', venue: 'Broadhurst Theatre', type: 'musical', status: 'open', category: 'broadway', previewDate: null, openingDate: '2025-02-13', closingDate: null, compositeScore: 72, posterUrl: null },
  'ragtime-2025': { id: 'ragtime-2025', title: 'Ragtime', slug: 'ragtime', venue: 'Todd Haimes Theatre', type: 'musical', status: 'open', category: 'broadway', previewDate: null, openingDate: '2025-03-27', closingDate: null, compositeScore: 78, posterUrl: null },
  // Diary-only shows (no show page)
  'rent-off-broadway-1996': { id: 'rent-off-broadway-1996', title: 'Rent', slug: 'rent-off-broadway-1996', venue: 'New York Theatre Workshop', type: 'musical', status: 'closed', category: 'off-broadway', previewDate: null, openingDate: '1996-02-13', closingDate: '1996-04-29', compositeScore: null, posterUrl: null, diaryOnly: true },
  'les-miserables-west-end-1985': { id: 'les-miserables-west-end-1985', title: 'Les Misérables', slug: 'les-miserables-west-end-1985', venue: 'Barbican Theatre', type: 'musical', status: 'closed', category: 'west-end', previewDate: null, openingDate: '1985-10-08', closingDate: '2019-07-13', compositeScore: null, posterUrl: null, diaryOnly: true },
};
