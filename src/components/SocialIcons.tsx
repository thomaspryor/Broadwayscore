import { SOCIAL_ACCOUNTS, type SocialPlatform } from '@/config/branding';

function IconSvg({ platform, size = 22 }: { platform: SocialPlatform; size?: number }) {
  switch (platform) {
    case 'instagram':
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M7 2h10a5 5 0 0 1 5 5v10a5 5 0 0 1-5 5H7a5 5 0 0 1-5-5V7a5 5 0 0 1 5-5zm0 2a3 3 0 0 0-3 3v10a3 3 0 0 0 3 3h10a3 3 0 0 0 3-3V7a3 3 0 0 0-3-3H7zm5 3.5a4.5 4.5 0 1 1 0 9 4.5 4.5 0 0 1 0-9zm0 2a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5zm5-2.75a1 1 0 1 1 0 2 1 1 0 0 1 0-2z" />
        </svg>
      );
    case 'threads':
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M12.2 2C6.8 2 3 5.8 3 12c0 6.1 3.6 10 9.1 10 4.5 0 7.2-2.4 8.2-5.1.6-1.7.6-3.4-.2-4.8-.8-1.5-2.2-2.4-4-2.7-1.3-3-4-3.8-6.4-2.5-.5.3-1 .8-1.4 1.4l1.7 1.2c.2-.4.5-.6.8-.8 1.4-.7 2.8-.1 3.4 1.4l-1.4.1c-3 .3-4.7 1.9-4.6 4.3.1 2 1.8 3.5 4.1 3.5 1.8 0 3.3-.8 4.2-2.3.7.4 1.2.9 1.4 1.5.4.9.2 2.1-.2 3-.7 1.9-2.6 3.4-6 3.4-4.4 0-6.9-3-6.9-7.9 0-4.9 2.9-7.9 7.3-7.9 3.3 0 5.5 1.4 6.7 4.3l1.9-.8C18.8 3.9 15.9 2 12.2 2zm0 12.5c1 0 1.7.4 2 1.1-.4.9-1.3 1.5-2.4 1.5-1 0-1.9-.5-1.9-1.3 0-.8.7-1.3 2.3-1.3z" />
        </svg>
      );
    case 'bluesky':
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M6.3 3.5C9 5.6 11.9 9.8 13 12.1c1.1-2.3 4-6.5 6.7-8.6 2-1.5 5.3-2.7 5.3 1.1 0 .8-.4 6.4-.7 7.3-.9 3.3-4.3 4.2-7.3 3.7 5.2.9 6.6 3.9 3.7 6.9-5.4 5.7-7.8-1.5-8.4-3.3l-.3-.8-.3.8c-.6 1.8-3 9-8.4 3.3-2.9-3 .5-6 3.7-6.9-3 .5-6.4-.4-7.3-3.7-.3-.9-.7-6.5-.7-7.3C-.3.8 3 2 5 3.5z" transform="translate(1.5 2)" />
        </svg>
      );
    case 'twitter':
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M18.9 2h3.3l-7.2 8.3L23.6 22h-6.7l-5.2-6.9L5.7 22H2.4l7.7-8.8L2 2h6.8l4.7 6.3L18.9 2zm-1.2 18h1.8L7.4 4H5.5l12.2 16z" />
        </svg>
      );
    case 'facebook':
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M13 22v-8h2.7l.4-3.1H13V8.9c0-.9.3-1.5 1.6-1.5h1.7V4.6c-.3 0-1.3-.1-2.5-.1-2.5 0-4.2 1.5-4.2 4.3v2.4H7v3.1h2.6V22H13z" />
        </svg>
      );
  }
}

/** Icons-only social row (dedicated Option B layout). */
export default function SocialIcons({ size = 22 }: { size?: number }) {
  return (
    <div className="flex flex-col items-center gap-2 mb-4 pb-4 border-b border-white/5">
      <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[rgba(212,165,116,0.6)]">
        Follow Us
      </span>
      <div className="flex items-center gap-5">
        {SOCIAL_ACCOUNTS.map((acc) => (
          <a
            key={acc.platform}
            href={acc.url}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={`Broadway Scorecard on ${acc.label}`}
            className="text-gray-400 hover:text-white transition-colors"
          >
            <IconSvg platform={acc.platform} size={size} />
          </a>
        ))}
      </div>
    </div>
  );
}
