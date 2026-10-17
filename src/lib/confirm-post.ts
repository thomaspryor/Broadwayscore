// BRO-5262: shared checks for the POST behind an emailed link's confirm page.
// The confirm form (GET) carries a hidden `confirm=1` field; a blind POST to
// the signed URL (link scanners probing forms, a replayed URL) lacks it. A
// browser that reports a cross-site origin is refused too: the real form
// always posts from the same origin.
export const CONFIRM_FIELD_HTML = '<input type="hidden" name="confirm" value="1">';

export async function isConfirmedPost(req: Request): Promise<boolean> {
  const site = req.headers.get('sec-fetch-site');
  if (site && site !== 'same-origin') return false;
  try {
    const form = await req.formData();
    return form.get('confirm') === '1';
  } catch {
    return false;
  }
}
