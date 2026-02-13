export default function StressTest({ html }: { html: string | null }) {
  if (!html) return null;

  return (
    <div className="max-w-prose mx-auto border-t border-white/10 pt-8">
      <h2 className="text-xl font-bold text-white mb-4 border-b border-white/10 pb-2">
        <span className="text-brand">Broadway Stress Test</span>
      </h2>
      <div
        className="prose prose-invert prose-lg max-w-none
          prose-p:text-gray-200 prose-p:leading-relaxed prose-p:mb-5
          prose-strong:text-white prose-strong:font-semibold
          prose-em:text-gray-300
          prose-a:text-brand prose-a:no-underline hover:prose-a:underline"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}
