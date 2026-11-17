-- AlterTable
ALTER TABLE "comment" ADD COLUMN "parent_comment_id" UUID;

-- CreateIndex
CREATE INDEX "comment_parent_comment_id_created_at_idx" ON "comment"("parent_comment_id", "created_at");

-- AddForeignKey
ALTER TABLE "comment" ADD CONSTRAINT "comment_parent_comment_id_fkey" FOREIGN KEY ("parent_comment_id") REFERENCES "comment"("comment_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
