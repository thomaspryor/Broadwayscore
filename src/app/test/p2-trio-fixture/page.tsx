'use client';

import AvatarImage from '@/components/AvatarImage';
import { ShowSearchDropdown } from '@/components/show-cards';

/**
 * Visual fixture for BRO-4303: a dead avatar URL falling back to initials, and
 * the search dropdown inside a padded (inset) card so its mobile width can be
 * checked against the card edge. Playwright / visual-qa only.
 */
export default function P2TrioFixturePage() {
  return (
    <div className="min-h-screen bg-surface text-white">
      <div className="max-w-md mx-auto px-4 py-8 space-y-8">
        <section data-testid="avatar-fallback">
          <h2 className="text-sm font-bold mb-3">Dead avatar_url falls back to initials</h2>
          <div className="flex items-center gap-3">
            <AvatarImage
              src="https://invalid.example/dead-avatar.png"
              className="w-10 h-10 rounded-full border border-white/10"
              fallback={
                <div className="w-10 h-10 rounded-full bg-brand/20 flex items-center justify-center text-brand font-bold text-sm">T</div>
              }
            />
            <span className="text-sm text-gray-400">Menu header</span>
          </div>
        </section>
        <section data-testid="inset-dropdown" className="card p-5">
          <h2 className="text-sm font-bold mb-3">Dropdown inside an inset card</h2>
          <ShowSearchDropdown
            autoFocus
            onSelect={() => {}}
            onClose={() => {}}
            renderAction={() => <span>+ Add</span>}
          />
        </section>
      </div>
    </div>
  );
}
