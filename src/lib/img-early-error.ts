/**
 * Ref callback for an <img> whose React `onError` swaps in a fallback.
 *
 * On a statically exported page the browser starts loading the image before
 * React hydrates. If the load fails in that window, the error event fires
 * before the `onError` handler exists, so the fallback never shows and a
 * broken-image icon stays on screen (BRO-4616: outlet logos from the favicon
 * service). Pass the same handler here as `ref={catchEarlyImgError(fn)}` and
 * an image that already failed is caught when it mounts.
 */
export function isFailedImage(img: Pick<HTMLImageElement, 'complete' | 'naturalWidth' | 'getAttribute'>): boolean {
  return img.complete && img.naturalWidth === 0 && !!img.getAttribute('src');
}

export function catchEarlyImgError(onError: () => void) {
  return (img: HTMLImageElement | null) => {
    if (img && isFailedImage(img)) onError();
  };
}
