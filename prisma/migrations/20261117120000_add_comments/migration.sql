-- CreateTable
CREATE TABLE "comment" (
    "comment_id" UUID NOT NULL,
    "content_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "body" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "comment_pkey" PRIMARY KEY ("comment_id")
);

-- CreateIndex
CREATE INDEX "comment_content_id_created_at_idx" ON "comment"("content_id", "created_at");

-- CreateIndex
CREATE INDEX "comment_user_id_created_at_idx" ON "comment"("user_id", "created_at");

-- AddForeignKey
ALTER TABLE "comment" ADD CONSTRAINT "comment_content_id_fkey" FOREIGN KEY ("content_id") REFERENCES "content"("content_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "comment" ADD CONSTRAINT "comment_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app_user"("user_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
