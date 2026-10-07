// Trusted Broadway trade outlets whose recoupment announcements may auto-apply
// via the Friday scraper → apply-commercial-pending pipeline.
//
// Sourced from outlets that have historically published verifiable recoupment
// trade-press articles (capitalization figures + paid-back quote). Adding an
// outlet here means we'll auto-flip designation/recouped fields in commercial.json
// based on its reporting — only add outlets with strong editorial standards.

const TRUSTED_RECOUPMENT_HOSTS = new Set([
  'playbill.com',
  'deadline.com',
  'variety.com',
  'broadwayworld.com',
  'nytimes.com',
  'nypost.com',
  'thewrap.com',
  'hollywoodreporter.com',
  'theatermania.com',
  'broadway.com',
  'nydailynews.com',
  'bloomberg.com',
]);

module.exports = { TRUSTED_RECOUPMENT_HOSTS };
