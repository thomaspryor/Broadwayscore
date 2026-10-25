import Link from 'next/link';

interface BreadcrumbItem {
  label: string;
  href?: string;
}

export default function Breadcrumb({ items, className }: { items: BreadcrumbItem[]; className?: string }) {
  return (
    <nav aria-label="Breadcrumb" className={`text-sm text-gray-500 ${className ?? 'mb-6'}`}>
      <ol className="flex items-center gap-1.5 flex-wrap">
        {items.map((item, i) => (
          <li
            key={i}
            className={`${i > 0 ? "before:content-['/'] before:mx-1.5" : ''}${!item.href ? ' text-gray-300 truncate' : ''}`}
            {...(!item.href ? { 'aria-current': 'page' as const } : {})}
          >
            {item.href ? (
              <Link href={item.href} className="hover:text-brand transition-colors">{item.label}</Link>
            ) : (
              item.label
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}
