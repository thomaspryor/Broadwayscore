/**
 * Theatre Record PDF-era links (/archive/volume/V/dest/N_slug) redirect to the
 * whole-volume PDF by issue number N. The slug is the title with punctuation
 * flattened by TR, and some slugs carry characters the server does not route:
 * 2:22 - A Ghost Story links as `dest/15:2_22___a_ghost_story` and the fetch
 * returned an HTML page, not the PDF (BRO-6127). Try the link as given, then
 * the colon percent-encoded, then the bare issue number, in that order.
 */
function pdfUrlVariants(url) {
  const base = String(url || '').replace(/#.*$/, '');
  const out = [base];
  const add = (u) => { if (u && !out.includes(u)) out.push(u); };
  add(base.replace(/(\/dest\/\d+):/, '$1%3A'));
  add(base.replace(/(\/dest\/\d+)[^/]*$/, '$1'));
  return out;
}

// First 120 printable chars of a non-PDF body, whitespace collapsed, for the
// probe note (an HTML error or login page says why the fetch was refused).
function nonPdfHead(buf) {
  return String(buf || '').replace(/<[^>]*>/g, ' ').replace(/[^\x20-\x7e]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
}

module.exports = { pdfUrlVariants, nonPdfHead };
