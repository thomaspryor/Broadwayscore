// City hub data (BRO-6517): regional productions tagged with a metro `city`
// (venue->metro table + field, BRO-6515), sectioned for the hub page. Tour
// stops come from data-tour-cities. Flag-gated like the regional category.

import { getRegionalShows } from './data-core';
import { isCategoryEnabled } from './markets';
import { sectionHubShows, type HubSections } from './city-hub';
import type { ComputedShow } from './engine';

export type CityHubShow = ComputedShow;

/** Regional productions in a metro, sectioned as of `today`. */
export function getCityHubShows(metro: string, today: string): HubSections<CityHubShow> {
  const shows = isCategoryEnabled('regional') ? (getRegionalShows() as CityHubShow[]) : [];
  return sectionHubShows(shows, metro, today);
}
