-- Diary photos: enforce the per-entry limit and file size/type in Supabase (BRO-6228).
--
-- Until now the 6-photo cap, the JPEG type and the size ceiling were client
-- discipline only (web src/lib/review-photo-model.ts, iOS lib/photo-types.ts), so
-- a modified client or a direct API call could exceed them. Both clients
-- re-encode to JPEG (long edge <= 2048, quality 0.82) and upload as image/jpeg,
-- so the real limits below never reject a legitimate upload.
--
-- Additive: replaces one function, adds one trigger, updates one bucket row.
-- Existing rows are not touched (a review that already holds more than 6 keeps
-- them; only new inserts are checked).

-- 1. At most 6 photos per review.
create or replace function public.enforce_review_photo_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Serialise concurrent inserts for the same review so two parallel uploads
  -- cannot both see 5 and both insert.
  perform pg_advisory_xact_lock(hashtextextended(new.review_id::text, 0));
  if (select count(*) from public.user_review_photos where review_id = new.review_id) >= 6 then
    raise exception 'A diary entry can have at most 6 photos'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists user_review_photos_limit on public.user_review_photos;
create trigger user_review_photos_limit
  before insert on public.user_review_photos
  for each row execute function public.enforce_review_photo_limit();

-- 2. Bucket-level size and type limits (Storage rejects the upload itself).
update storage.buckets
   set file_size_limit = 10485760,
       allowed_mime_types = array['image/jpeg']
 where id = 'diary-photos';
