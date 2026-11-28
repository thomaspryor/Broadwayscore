export default function StressTest({ html }: { html: string | null }) {
  if (!html) return null;

  return (
    <div
      className="prose prose-invert prose-lg max-w-prose mx-auto
        prose-headings:text-white prose-headings:font-bold prose-headings:mt-10 prose-headings:mb-4
        prose-h2:text-xl prose-h2:border-b prose-h2:border-white/10 prose-h2:pb-2
        prose-p:text-gray-200 prose-p:leading-relaxed prose-p:mb-5
        prose-strong:text-white prose-strong:font-semibold
        prose-em:text-gray-300
        prose-a:text-brand prose-a:no-underline hover:prose-a:underline"
    >
      <h2><span className="text-brand">Broadway Stress Test</span></h2>
      <div dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
}
