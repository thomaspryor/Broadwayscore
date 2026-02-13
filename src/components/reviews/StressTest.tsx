export default function StressTest({ html }: { html: string | null }) {
  if (!html) return null;

  return (
    <div className="card border-l-4 border-brand/40 p-5 sm:p-6">
      <h2 className="text-lg font-bold text-white mb-4 flex items-center gap-2">
        <span className="text-brand">Broadway Stress Test</span>
      </h2>
      <div
        className="prose prose-invert prose-sm max-w-none
          prose-p:text-gray-300 prose-p:leading-relaxed
          prose-strong:text-white prose-strong:font-semibold
          prose-a:text-brand prose-a:no-underline hover:prose-a:underline"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}
