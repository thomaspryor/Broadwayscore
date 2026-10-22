// Session replay sample. Decided here, per tab, rather than by PostHog's own
// sampleRate: PostHog downloads its ~68kB recorder before it samples, so every
// visitor paid for it while only 1 in 10 was recorded.
export const RECORDING_SAMPLE_RATE = 0.1;
export const RECORDING_SAMPLE_KEY = 'bsc_ph_replay';

type SampleStore = Pick<Storage, 'getItem' | 'setItem'>;

/**
 * Whether this tab is in the replay sample. The choice is kept in
 * sessionStorage so every page of a visit agrees; with no storage (blocked or
 * absent) each page load is sampled on its own.
 */
export function sampledForReplay(
  random: () => number = Math.random,
  getStore: () => SampleStore | undefined = () => window.sessionStorage,
): boolean {
  try {
    const store = getStore();
    if (!store) return random() < RECORDING_SAMPLE_RATE;
    let v = store.getItem(RECORDING_SAMPLE_KEY);
    if (v !== '1' && v !== '0') {
      v = random() < RECORDING_SAMPLE_RATE ? '1' : '0';
      store.setItem(RECORDING_SAMPLE_KEY, v);
    }
    return v === '1';
  } catch {
    // Reading window.sessionStorage throws when the browser blocks storage.
    return random() < RECORDING_SAMPLE_RATE;
  }
}
