'use client';

import type { ShowLookup } from '@/types/user';
import PhotoTile from './PhotoTile';
import { longDate, titleFor, type FeedSlide } from './feed-model';

interface PhotoWallProps {
  slides: FeedSlide[];
  showMap: Record<string, ShowLookup>;
  onOpen: (index: number) => void;
}

/**
 * Photo wall: every diary photo as a square tile (the app's PhotoWallGrid).
 * Edge to edge with hairline gaps on phones, rounded tiles from sm up; the
 * show name and date fade in on hover where there is a pointer.
 */
export default function PhotoWall({ slides, showMap, onOpen }: PhotoWallProps) {
  return (
    <ul className="-mx-4 sm:mx-0 grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-5 gap-0.5 sm:gap-1.5" aria-label="All photos">
      {slides.map((slide, i) => {
        const title = titleFor(showMap[slide.review.show_id], slide.review.show_id);
        const date = longDate(slide.review.date_seen);
        return (
          <li key={slide.photo.id} className="min-w-0">
            <PhotoTile
              url={slide.photo.url}
              label={`Open photo from ${title}${date ? `, ${date}` : ''}`}
              onOpen={() => onOpen(i)}
              className="w-full aspect-square sm:rounded-lg"
            >
              <span className="pointer-events-none absolute inset-x-0 bottom-0 hidden sm:block px-2 pb-1.5 pt-6 bg-gradient-to-t from-black/80 to-transparent text-left opacity-0 group-hover/photo:opacity-100 group-focus-visible/photo:opacity-100 transition-opacity">
                <span className="block text-xs font-bold text-white truncate">{title}</span>
                {date && <span className="block text-xs text-gray-300 truncate">{date}</span>}
              </span>
            </PhotoTile>
          </li>
        );
      })}
    </ul>
  );
}
