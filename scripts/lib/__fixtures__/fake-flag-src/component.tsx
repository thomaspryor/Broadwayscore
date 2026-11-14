export function useFakeFlag(ph) {
  return ph?.getFeatureFlag?.('totally-fake-flag');
}
