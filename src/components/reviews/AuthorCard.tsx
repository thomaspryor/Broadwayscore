import { AUTHOR } from '@/config/author';

export default function AuthorCard() {
  return (
    <div className="card p-4 sm:p-5 flex items-center gap-4 border-l-4 border-brand/30">
      {AUTHOR.photo && (
        <img
          src={AUTHOR.photo}
          alt={AUTHOR.name}
          className="w-12 h-12 rounded-full object-cover flex-shrink-0"
        />
      )}
      <div className="min-w-0">
        <p className="text-sm font-semibold text-white">{AUTHOR.name}</p>
        <p className="text-sm text-gray-400">{AUTHOR.bio}</p>
      </div>
    </div>
  );
}
