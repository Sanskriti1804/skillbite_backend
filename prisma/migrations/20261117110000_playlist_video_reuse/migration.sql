-- Allow the same video in multiple playlists; still unique within one section.
DROP INDEX IF EXISTS "lesson_video_content_id_key";
CREATE UNIQUE INDEX "lesson_module_id_video_content_id_key" ON "lesson"("module_id", "video_content_id");
CREATE INDEX "lesson_video_content_id_idx" ON "lesson"("video_content_id");
