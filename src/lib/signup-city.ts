// City tag for email signups (BRO-6912). A signup from a city hub page, or from
// a local show's page, records that metro slug next to `market`, so a Chicago
// or DC email is possible later. It adds no list and sends nothing.
import { ALL_HUB_CITIES } from './city-hub';

/** Metro slug ("chicago-il") for a signup, or undefined when it has no city. Only registry slugs pass, so page text never reaches the form. */
export function signupCity(pathname: string | null | undefined, showCity?: string | null): string | undefined {
  const fromShow = showCity && Object.hasOwn(ALL_HUB_CITIES, showCity) ? showCity : undefined;
  if (fromShow) return fromShow;
  const m = /^\/tours\/([^/?#]+)/.exec(pathname || '');
  return m && Object.hasOwn(ALL_HUB_CITIES, m[1]) ? m[1] : undefined;
}

export interface SignupBodyInput {
  email: string;
  source: string;
  market: string;
  page: string;
  pathname: string | null | undefined;
  city?: string | null;
  firstName?: string;
  /** Per-show follow signups carry the show; list signups do not. */
  showId?: string;
  showTitle?: string;
  isSubscriber: boolean;
}

/** The JSON a signup posts to Formspree. Pure, so tests read the real payload (the hook only sends it). */
export function buildSignupBody(i: SignupBodyInput): Record<string, string> {
  const body: Record<string, string> = {
    email: i.email.toLowerCase().trim(),
    source: i.source,
    market: i.market,
    page: i.page,
  };
  const city = signupCity(i.pathname, i.city);
  if (city) body.city = city;
  if (i.firstName) body.firstName = i.firstName;
  if (!i.isSubscriber && i.showId) {
    body.showId = i.showId;
    if (i.showTitle) body.showTitle = i.showTitle;
  }
  return body;
}
