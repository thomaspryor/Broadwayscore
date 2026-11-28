/**
 * Hand-written bios for critic pages, keyed by critic slug.
 * Critics without an entry keep the auto-generated "Critic at <outlet>" text.
 * Keep each bio to one or two plain sentences and only state facts the critic
 * or their outlet has confirmed.
 */
export const CRITIC_BIOS: Record<string, string> = {
  'roma-torre':
    'Host of 5th Row Center, a talk show about Broadway and live theater. Former NY1 theater critic.',
};

export function getCriticBio(slug: string): string | undefined {
  return CRITIC_BIOS[slug];
}
