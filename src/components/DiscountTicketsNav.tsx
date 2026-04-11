import Link from 'next/link';

type DiscountPage = 'all' | 'lotteries' | 'rush' | 'standing-room' | 'best-value';
type DiscountMarket = 'broadway' | 'west-end';

const tabs: { id: DiscountPage; label: string; shortLabel: string; path: string }[] = [
  { id: 'all', label: 'All Discounts', shortLabel: 'All', path: '/discount-tickets' },
  { id: 'lotteries', label: 'Lotteries', shortLabel: 'Lottery', path: '/lotteries' },
  { id: 'rush', label: 'Rush', shortLabel: 'Rush', path: '/rush' },
  { id: 'standing-room', label: 'Standing Room', shortLabel: 'SRO', path: '/standing-room' },
  { id: 'best-value', label: 'Best Value', shortLabel: 'Value', path: '/best-value' },
];

interface DiscountTicketsNavProps {
  active: DiscountPage;
  /**
   * Which market the user is browsing. Defaults to 'broadway' (existing NYC
   * routes). Pass 'west-end' from /west-end/{lotteries,rush,...} pages to get
   * the /west-end/-prefixed hrefs.
   */
  market?: DiscountMarket;
}

export function DiscountTicketsNav({ active, market = 'broadway' }: DiscountTicketsNavProps) {
  const prefix = market === 'west-end' ? '/west-end' : '';
  return (
    <nav className="flex gap-1 overflow-x-auto scrollbar-hide mb-6 -mx-4 px-4 sm:mx-0 sm:px-0" aria-label="Discount ticket categories">
      {tabs.map(tab => {
        const isActive = tab.id === active;
        const href = `${prefix}${tab.path}`;
        return (
          <Link
            key={tab.id}
            href={href}
            className={`whitespace-nowrap px-3 py-2 rounded-lg text-sm font-medium transition-colors shrink-0 ${
              isActive
                ? 'bg-brand/15 text-brand border border-brand/30'
                : 'text-gray-400 hover:text-white hover:bg-white/5'
            }`}
            aria-current={isActive ? 'page' : undefined}
          >
            <span className="hidden sm:inline">{tab.label}</span>
            <span className="sm:hidden">{tab.shortLabel}</span>
          </Link>
        );
      })}
    </nav>
  );
}
