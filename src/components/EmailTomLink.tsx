'use client';

/**
 * "Email Tom" link (owner, 2026-10-26). The address is assembled only when the
 * link is clicked, so it never appears in the page HTML for scrapers to
 * harvest. Without JavaScript (most bots) the link opens the feedback form.
 */

const USER = 'tom';
const DOMAIN = ['broadwayscorecard', 'com'];

export default function EmailTomLink({ className, label = 'Email Tom' }: { className?: string; label?: string }) {
  return (
    <a
      href="/feedback"
      className={className}
      onClick={(e) => {
        e.preventDefault();
        window.location.href = `mailto:${USER}@${DOMAIN.join('.')}?subject=${encodeURIComponent('Broadway Scorecard')}`;
      }}
    >
      {label}
    </a>
  );
}
