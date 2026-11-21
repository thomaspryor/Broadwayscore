export const SHARED_FLAG = 'flag-b';
export function useIt(ph) {
  return ph?.getFeatureFlag?.(SHARED_FLAG);
}
