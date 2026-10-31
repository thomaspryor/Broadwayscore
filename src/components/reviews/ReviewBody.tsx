export default function ReviewBody({ html }: { html: string }) {
  return (
    <div
      className="prose prose-invert prose-lg max-w-prose mx-auto
        prose-headings:text-white prose-headings:font-bold prose-headings:mt-10 prose-headings:mb-4
        prose-h2:text-xl prose-h2:border-b prose-h2:border-white/10 prose-h2:pb-2
        prose-p:text-gray-200 prose-p:leading-relaxed prose-p:mb-5
        prose-strong:text-white prose-strong:font-semibold
        prose-em:text-gray-300
        prose-blockquote:border-l-brand/40 prose-blockquote:text-gray-300 prose-blockquote:italic prose-blockquote:not-italic prose-blockquote:font-normal
        prose-a:text-brand prose-a:no-underline hover:prose-a:underline
        prose-ul:text-gray-200 prose-ol:text-gray-200
        prose-li:marker:text-brand/60"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
