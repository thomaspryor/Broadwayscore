// Counts-only summary of Formspree submissions by the `city` tag (BRO-6912).
// Never returns or prints an email address.
function countByCity(submissions) {
  const out = { total: 0, tagged: 0, byCity: {} };
  for (const s of submissions || []) {
    out.total++;
    const city = s && typeof s.city === 'string' ? s.city.trim() : '';
    if (!city) continue;
    out.tagged++;
    out.byCity[city] = (out.byCity[city] || 0) + 1;
  }
  return out;
}
module.exports = { countByCity };
