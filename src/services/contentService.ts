import type { Prisma } from "@prisma/client";
import { LIST_LIMIT } from "../deps.js";
import { HttpError } from "../errors.js";
import type { Access } from "./access.js";

type FeedItem = {
  contentId: string;
  contentType: string;
  title: string;
  description: string | null;
  publishedAt: Date | null;
  hasMedia?: boolean;
  mediaUrl?: string | null;
  thumbnailUrl?: string | null;
  commentCount?: number;
  categories: Array<{ name: string; slug: string }>;
};

function shuffleInPlace<T>(items: T[]): T[] {
  for (let i = items.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = items[i]!;
    items[i] = items[j]!;
    items[j] = tmp;
  }
  return items;
}

/** Mix categories so Home does not play one folder in a row. */
function interleaveByCategory(items: FeedItem[]): FeedItem[] {
  const buckets = new Map<string, FeedItem[]>();
  for (const item of items) {
    const key = item.categories[0]?.slug || "uncategorized";
    const list = buckets.get(key) ?? [];
    list.push(item);
    buckets.set(key, list);
  }
  for (const list of buckets.values()) shuffleInPlace(list);
  const keys = shuffleInPlace([...buckets.keys()]);
  const queues = keys.map((key) => buckets.get(key) ?? []);
  const mixed: FeedItem[] = [];
  let added = true;
  while (added) {
    added = false;
    for (const queue of queues) {
      const next = queue.shift();
      if (!next) continue;
      mixed.push(next);
      added = true;
    }
  }
  return mixed;
}

export function createContentService(access: Access) {
  const { prisma, deps, ownContent } = access;

  return {
    async createVideo(userId: string, body: Record<string, unknown>) {
      const description = typeof body.description === "string" ? body.description.trim() : "";
      if (!description) throw new HttpError(400, "validation", "Description is required");
      const titleRaw = typeof body.title === "string" ? body.title.trim() : "";
      const title = titleRaw || (description.length > 80 ? `${description.slice(0, 77)}...` : description);
      const content = await prisma.content.create({
        data: {
          creatorId: userId,
          contentType: "VIDEO",
          title,
          description,
          keywords: typeof body.keywords === "string" ? body.keywords : null,
          status: "DRAFT",
          video: {
            create: {
              mediaReference: "",
              durationSeconds: Number.isInteger(body.durationSeconds) ? body.durationSeconds as number : 0,
              sources: typeof body.sources === "string" ? body.sources : null,
            },
          },
        },
      });
      if (Array.isArray(body.tagIds)) {
        for (const tagId of body.tagIds) {
          if (typeof tagId === "string") await prisma.contentTag.create({ data: { contentId: content.contentId, tagId } });
        }
      }
      if (Array.isArray(body.categoryIds)) {
        for (const categoryId of body.categoryIds) {
          if (typeof categoryId === "string") {
            await prisma.contentCategory.create({ data: { contentId: content.contentId, categoryId } });
          }
        }
      }
      return { contentId: content.contentId, status: "DRAFT" as const };
    },

    async updateVideo(auth: Parameters<typeof ownContent>[0], contentId: string, body: Record<string, unknown>) {
      const content = await ownContent(auth, contentId);
      if (content.contentType !== "VIDEO") throw new HttpError(404, "not_found", "Not found");
      if (content.deletedAt) throw new HttpError(404, "not_found", "Not found");
      const nextStatus = body.status === "DRAFT" || body.status === "PUBLISHED" || body.status === "UNPUBLISHED"
        ? body.status
        : undefined;
      await prisma.content.update({
        where: { contentId: content.contentId },
        data: {
          title: typeof body.title === "string" ? body.title : undefined,
          description: typeof body.description === "string" ? body.description : undefined,
          keywords: typeof body.keywords === "string" ? body.keywords : undefined,
          status: nextStatus,
          video: typeof body.sources === "string" ? { update: { sources: body.sources } } : undefined,
        },
      });
      if (Array.isArray(body.categoryIds)) {
        await prisma.contentCategory.deleteMany({ where: { contentId: content.contentId } });
        for (const categoryId of body.categoryIds) {
          if (typeof categoryId === "string") {
            await prisma.contentCategory.create({ data: { contentId: content.contentId, categoryId } });
          }
        }
      }
      if (Array.isArray(body.tagIds)) {
        await prisma.contentTag.deleteMany({ where: { contentId: content.contentId } });
        for (const tagId of body.tagIds) {
          if (typeof tagId === "string") {
            await prisma.contentTag.create({ data: { contentId: content.contentId, tagId } });
          }
        }
      }
      return { contentId: content.contentId, status: nextStatus ?? content.status };
    },

    async deleteVideo(auth: Parameters<typeof ownContent>[0], contentId: string) {
      const content = await ownContent(auth, contentId);
      if (content.contentType !== "VIDEO") throw new HttpError(404, "not_found", "Not found");
      await prisma.content.update({
        where: { contentId: content.contentId },
        data: { deletedAt: new Date(), status: "REMOVED" },
      });
      return { status: "REMOVED" as const };
    },

    async saveMedia(auth: Parameters<typeof ownContent>[0], contentId: string, body: Record<string, unknown>) {
      const content = await ownContent(auth, contentId);
      const mime = typeof body.mimeType === "string" ? body.mimeType : "";
      const data = typeof body.dataBase64 === "string" ? body.dataBase64 : "";
      if (!mime.startsWith("video/")) throw new HttpError(400, "validation", "File must be a video");
      const bytes = Buffer.from(data, "base64");
      if (bytes.length === 0) throw new HttpError(400, "validation", "File is empty");
      const category = await prisma.contentCategory.findFirst({
        where: { contentId: content.contentId },
        include: { category: true },
      });
      const reference = await deps.storage.saveVideo(content.contentId, bytes, {
        categorySlug: category?.category.slug,
      });
      await prisma.videoDetails.update({
        where: { contentId: content.contentId },
        data: {
          mediaReference: reference,
          durationSeconds: Number.isInteger(body.durationSeconds) ? body.durationSeconds as number : content.video?.durationSeconds ?? 0,
        },
      });
      return { mediaReference: reference };
    },

    async readMedia(contentId: string, getAuth: () => Promise<Parameters<typeof ownContent>[0]>) {
      const row = await prisma.content.findUnique({ where: { contentId }, include: { video: true } });
      if (!row?.video || !row.video.mediaReference) throw new HttpError(404, "not_found", "Not found");
      const published = row.status === "PUBLISHED" && !row.deletedAt;
      if (!published) {
        const auth = await getAuth();
        if (auth.role !== "ADMIN" && auth.userId !== row.creatorId) throw new HttpError(403, "forbidden", "Not allowed");
      }
      return deps.storage.read(row.video.mediaReference);
    },

    async playbackUrl(
      contentId: string,
      getAuth: () => Promise<Parameters<typeof ownContent>[0]>,
      quality: "feed" | "full" = "feed",
    ) {
      const row = await prisma.content.findUnique({ where: { contentId }, include: { video: true } });
      if (!row?.video || !row.video.mediaReference) throw new HttpError(404, "not_found", "Not found");
      const published = row.status === "PUBLISHED" && !row.deletedAt;
      if (!published) {
        const auth = await getAuth();
        if (auth.role !== "ADMIN" && auth.userId !== row.creatorId) throw new HttpError(403, "forbidden", "Not allowed");
      }
      return deps.storage.playbackUrl(row.video.mediaReference, quality);
    },

    async publishVideo(auth: Parameters<typeof ownContent>[0], contentId: string) {
      const content = await ownContent(auth, contentId);
      const video = content.video;
      if (!video?.mediaReference || !content.description?.trim()) {
        throw new HttpError(400, "validation", "Video needs media and a description before publish");
      }
      if (!content.keywords?.trim() || !video.sources?.trim()) {
        await prisma.content.update({
          where: { contentId: content.contentId },
          data: {
            keywords: content.keywords?.trim() || "tutorial, short-form",
            video: {
              update: {
                sources: video.sources?.trim() || "Original creator material",
              },
            },
          },
        });
      }
      await prisma.content.update({
        where: { contentId: content.contentId },
        data: { status: "PUBLISHED", publishedAt: content.publishedAt ?? new Date() },
      });
      return { status: "PUBLISHED" as const };
    },

    async takedown(auth: Parameters<typeof ownContent>[0], contentId: string) {
      const content = await ownContent(auth, contentId);
      await prisma.content.update({ where: { contentId: content.contentId }, data: { status: "UNPUBLISHED" } });
      return { status: "UNPUBLISHED" as const };
    },

    async addCaption(auth: Parameters<typeof ownContent>[0], contentId: string, body: Record<string, unknown>) {
      await ownContent(auth, contentId);
      const method = body.method === "UPLOADED" || body.method === "GENERATED" ? body.method : "";
      if (!method) throw new HttpError(400, "validation", "Caption method is required");
      try {
        const caption = await prisma.videoCaption.create({
          data: {
            videoContentId: contentId,
            languageCode: typeof body.languageCode === "string" ? body.languageCode : "en",
            format: typeof body.format === "string" ? body.format : "vtt",
            method,
            captionReference: typeof body.captionReference === "string" ? body.captionReference : "inline",
            reviewedAt: body.reviewed === true ? new Date() : null,
          },
        });
        return { captionId: caption.captionId };
      } catch {
        throw new HttpError(409, "conflict", "Caption already exists");
      }
    },

    async addAttachment(auth: Parameters<typeof ownContent>[0], contentId: string, body: Record<string, unknown>) {
      await ownContent(auth, contentId);
      const kind = body.kind;
      if (kind !== "PDF" && kind !== "TEXT" && kind !== "HYPERLINK") throw new HttpError(400, "validation", "Invalid attachment");
      const reference = typeof body.reference === "string" ? body.reference : "";
      if (!reference) throw new HttpError(400, "validation", "Reference is required");
      const row = await prisma.contentAttachment.create({ data: { contentId, kind, reference } });
      return { attachmentId: row.attachmentId };
    },

    async removeAttachment(auth: Parameters<typeof ownContent>[0], contentId: string, attachmentId: string) {
      await ownContent(auth, contentId);
      const attachment = await prisma.contentAttachment.findUnique({ where: { attachmentId } });
      if (!attachment || attachment.contentId !== contentId) throw new HttpError(404, "not_found", "Not found");
      await prisma.contentAttachment.delete({ where: { attachmentId: attachment.attachmentId } });
      return { status: "ok" as const };
    },

    async createCourse(userId: string, body: Record<string, unknown>) {
      const title = typeof body.title === "string" ? body.title.trim() : "";
      if (!title) throw new HttpError(400, "validation", "Title is required");
      const content = await prisma.content.create({
        data: {
          creatorId: userId,
          contentType: "COURSE",
          title,
          description: typeof body.description === "string" ? body.description : null,
          status: "DRAFT",
          course: { create: {} },
        },
      });
      return { contentId: content.contentId };
    },

    async updateCourse(auth: Parameters<typeof ownContent>[0], contentId: string, body: Record<string, unknown>) {
      const content = await ownContent(auth, contentId);
      if (content.contentType !== "COURSE" || content.deletedAt) throw new HttpError(404, "not_found", "Not found");
      const title = typeof body.title === "string" ? body.title.trim() : undefined;
      const description = typeof body.description === "string" ? body.description.trim() : undefined;
      if (title !== undefined && !title) throw new HttpError(400, "validation", "Course name is required");
      await prisma.content.update({
        where: { contentId: content.contentId },
        data: {
          title: title || undefined,
          description: description !== undefined ? description || null : undefined,
        },
      });
      return { contentId: content.contentId };
    },

    async setCourseVisibility(
      auth: Parameters<typeof ownContent>[0],
      contentId: string,
      visibility: unknown,
    ) {
      const content = await ownContent(auth, contentId);
      if (content.contentType !== "COURSE" || content.deletedAt) throw new HttpError(404, "not_found", "Not found");
      const next =
        visibility === "PUBLISHED" || visibility === "public" ? "PUBLISHED"
          : visibility === "UNPUBLISHED" || visibility === "private" || visibility === "DRAFT" ? "UNPUBLISHED"
            : "";
      if (!next) throw new HttpError(400, "validation", "Visibility must be public or private");
      if (next === "PUBLISHED") {
        return this.publishCourse(auth, contentId);
      }
      await prisma.content.update({
        where: { contentId: content.contentId },
        data: { status: "UNPUBLISHED" },
      });
      return { status: "UNPUBLISHED" as const };
    },

    async addModule(auth: Parameters<typeof ownContent>[0], contentId: string, body: Record<string, unknown>) {
      await ownContent(auth, contentId);
      const title = typeof body.title === "string" ? body.title.trim() : "";
      const position = body.position;
      if (!title || !Number.isInteger(position) || (position as number) < 1) throw new HttpError(400, "validation", "Module name and position are required");
      try {
        const module = await prisma.courseModule.create({ data: { courseContentId: contentId, title, position: position as number } });
        return { moduleId: module.moduleId };
      } catch {
        throw new HttpError(409, "conflict", "Position is already used");
      }
    },

    async addLesson(auth: Parameters<typeof ownContent>[0], moduleId: string, body: Record<string, unknown>) {
      const module = await prisma.courseModule.findUnique({ where: { moduleId } });
      if (!module) throw new HttpError(404, "not_found", "Not found");
      await ownContent(auth, module.courseContentId);
      const videoContentId = typeof body.videoContentId === "string" ? body.videoContentId : "";
      const position = body.position;
      if (!videoContentId || !Number.isInteger(position) || (position as number) < 1) {
        throw new HttpError(400, "validation", "Video and position are required");
      }
      const video = await prisma.content.findUnique({ where: { contentId: videoContentId } });
      if (!video || video.contentType !== "VIDEO" || video.deletedAt) {
        throw new HttpError(404, "not_found", "Video not found");
      }
      const titleRaw = typeof body.title === "string" ? body.title.trim() : "";
      const title = titleRaw || (video.description?.trim() || video.title || "Video").slice(0, 80);
      try {
        const lesson = await prisma.lesson.create({ data: { moduleId: module.moduleId, title, position: position as number, videoContentId } });
        return { lessonId: lesson.lessonId };
      } catch {
        throw new HttpError(409, "conflict", "Video is already in a course or position is taken");
      }
    },

    async removeLesson(auth: Parameters<typeof ownContent>[0], moduleId: string, lessonId: string) {
      const module = await prisma.courseModule.findUnique({ where: { moduleId } });
      if (!module) throw new HttpError(404, "not_found", "Not found");
      await ownContent(auth, module.courseContentId);
      const lesson = await prisma.lesson.findUnique({ where: { lessonId } });
      if (!lesson || lesson.moduleId !== moduleId) throw new HttpError(404, "not_found", "Not found");
      await prisma.lesson.delete({ where: { lessonId } });
      return { status: "ok" as const };
    },

    async addVideoToCourse(auth: Parameters<typeof ownContent>[0], courseContentId: string, videoContentIdRaw: unknown) {
      const content = await ownContent(auth, courseContentId);
      if (content.contentType !== "COURSE" || content.deletedAt) throw new HttpError(404, "not_found", "Not found");
      const videoContentId = typeof videoContentIdRaw === "string" ? videoContentIdRaw : "";
      if (!videoContentId) throw new HttpError(400, "validation", "Video is required");
      const video = await prisma.content.findUnique({ where: { contentId: videoContentId } });
      if (!video || video.contentType !== "VIDEO" || video.deletedAt) {
        throw new HttpError(404, "not_found", "Video not found");
      }
      const alreadyInPlaylist = await prisma.lesson.findFirst({
        where: { videoContentId, module: { courseContentId } },
      });
      if (alreadyInPlaylist) throw new HttpError(409, "conflict", "Video is already in this course");

      let module = await prisma.courseModule.findFirst({
        where: { courseContentId },
        orderBy: { position: "asc" },
        include: { lessons: true },
      });
      if (!module) {
        module = await prisma.courseModule.create({
          data: { courseContentId, title: "Videos", position: 1 },
          include: { lessons: true },
        });
      }
      const position = module.lessons.length + 1;
      const title = (video.description?.trim() || video.title || "Video").slice(0, 80);
      try {
        const lesson = await prisma.lesson.create({
          data: { moduleId: module.moduleId, title, position, videoContentId },
        });
        return { lessonId: lesson.lessonId, moduleId: module.moduleId, position };
      } catch {
        throw new HttpError(409, "conflict", "Could not add video to course");
      }
    },

    async deleteCourse(auth: Parameters<typeof ownContent>[0], contentId: string) {
      const content = await ownContent(auth, contentId);
      if (content.contentType !== "COURSE") throw new HttpError(404, "not_found", "Not found");
      const modules = await prisma.courseModule.findMany({
        where: { courseContentId: content.contentId },
        select: { moduleId: true },
      });
      await prisma.$transaction(async (tx) => {
        for (const module of modules) {
          await tx.lesson.deleteMany({ where: { moduleId: module.moduleId } });
        }
        await tx.courseModule.deleteMany({ where: { courseContentId: content.contentId } });
        await tx.content.update({
          where: { contentId: content.contentId },
          data: { deletedAt: new Date(), status: "REMOVED" },
        });
      });
      return { status: "REMOVED" as const };
    },

    async publishCourse(auth: Parameters<typeof ownContent>[0], contentId: string) {
      const content = await ownContent(auth, contentId);
      const modules = await prisma.courseModule.findMany({
        where: { courseContentId: content.contentId },
        include: { lessons: { include: { video: { include: { content: { include: { tags: true } } } } } } },
      });
      if (modules.length === 0 || modules.some((module) => !module.title || module.lessons.length === 0)) {
        throw new HttpError(400, "validation", "Course is incomplete");
      }
      for (const module of modules) {
        for (const lesson of module.lessons) {
          const videoContent = lesson.video.content;
          const ready = lesson.video.mediaReference && videoContent.description?.trim();
          if (!ready) throw new HttpError(400, "validation", "Each lesson video needs media and a description");
        }
      }
      await prisma.content.update({
        where: { contentId: content.contentId },
        data: { status: "PUBLISHED", publishedAt: content.publishedAt ?? new Date() },
      });
      return { status: "PUBLISHED" as const };
    },

    async mine(userId: string) {
      const items = await prisma.content.findMany({
        where: { creatorId: userId, deletedAt: null },
        orderBy: { updatedAt: "desc" },
        take: LIST_LIMIT,
        include: { video: true },
      });
      return {
        limit: LIST_LIMIT,
        items: items.map((item) => {
          const reference = item.video?.mediaReference ?? "";
          return {
            contentId: item.contentId,
            contentType: item.contentType,
            title: item.title,
            description: item.description,
            status: item.status,
            updatedAt: item.updatedAt,
            publishedAt: item.publishedAt,
            hasMedia: Boolean(reference),
            thumbnailUrl: reference ? deps.storage.thumbnailUrl(reference) : null,
          };
        }),
      };
    },

    async categories() {
      const items = await prisma.category.findMany({ where: { isActive: true }, orderBy: { name: "asc" } });
      return { items };
    },

    async tags() {
      const items = await prisma.tag.findMany({ orderBy: { name: "asc" } });
      return { items };
    },

    async search(query: { q?: unknown; category?: unknown; sort?: unknown }) {
      const q = typeof query.q === "string" ? query.q.trim() : "";
      const category = typeof query.category === "string" ? query.category : "";
      const sort = typeof query.sort === "string" ? query.sort.trim().toLowerCase() : "newest";
      const random = sort === "random" || sort === "mixed";
      const where: Prisma.ContentWhereInput = { status: "PUBLISHED", deletedAt: null };
      if (q) {
        where.OR = [
          { title: { contains: q, mode: "insensitive" } },
          { description: { contains: q, mode: "insensitive" } },
          { keywords: { contains: q, mode: "insensitive" } },
          { tags: { some: { tag: { name: { contains: q, mode: "insensitive" } } } } },
        ];
      }
      if (category) where.categories = { some: { category: { slug: category } } };
      const rows = await prisma.content.findMany({
        where,
        take: random ? Math.max(LIST_LIMIT * 3, 60) : LIST_LIMIT,
        orderBy: { publishedAt: "desc" },
        include: {
          video: true,
          categories: { include: { category: true } },
          _count: { select: { comments: { where: { deletedAt: null } } } },
        },
      });

      const mapped = rows.map((item) => {
        const reference = item.video?.mediaReference ?? "";
        return {
          contentId: item.contentId,
          contentType: item.contentType,
          title: item.title,
          description: item.description,
          publishedAt: item.publishedAt,
          hasMedia: Boolean(reference),
          mediaUrl: reference ? deps.storage.playbackUrl(reference, "feed") : null,
          thumbnailUrl: reference ? deps.storage.thumbnailUrl(reference) : null,
          commentCount: item._count.comments,
          categories: item.categories.map((row) => ({
            name: row.category.name,
            slug: row.category.slug,
          })),
        };
      });

      const items = random ? interleaveByCategory(mapped).slice(0, LIST_LIMIT * 2) : mapped;
      return {
        limit: items.length,
        items,
      };
    },

    async contentDetail(contentId: string, getAuth: () => Promise<Parameters<typeof ownContent>[0]>) {
      const content = await prisma.content.findUnique({
        where: { contentId },
        include: {
          video: true,
          course: { include: { modules: { include: { lessons: true }, orderBy: { position: "asc" } } } },
          attachments: true,
          categories: { include: { category: true } },
          tags: { include: { tag: true } },
        },
      });
      if (!content || content.deletedAt) throw new HttpError(404, "not_found", "Not found");
      if (content.status !== "PUBLISHED") {
        try {
          const auth = await getAuth();
          if (auth.role !== "ADMIN" && auth.userId !== content.creatorId) throw new HttpError(404, "not_found", "Not found");
        } catch {
          throw new HttpError(404, "not_found", "Not found");
        }
      }
      return {
        contentId: content.contentId,
        contentType: content.contentType,
        title: content.title,
        description: content.description,
        keywords: content.keywords,
        sources: content.video?.sources ?? null,
        status: content.status,
        hasMedia: Boolean(content.video?.mediaReference),
        categories: content.categories.map((row) => ({
          categoryId: row.category.categoryId,
          name: row.category.name,
          slug: row.category.slug,
        })),
        tags: content.tags.map((row) => ({
          tagId: row.tag.tagId,
          name: row.tag.name,
          slug: row.tag.slug,
        })),
        modules: content.course?.modules.map((module) => ({
          moduleId: module.moduleId,
          title: module.title,
          position: module.position,
          lessons: module.lessons.slice().sort((a, b) => a.position - b.position).map((lesson) => ({
            lessonId: lesson.lessonId,
            title: lesson.title,
            position: lesson.position,
            videoContentId: lesson.videoContentId,
          })),
        })),
        attachments: content.attachments.map((item) => ({ attachmentId: item.attachmentId, kind: item.kind, reference: item.reference })),
      };
    },
  };
}
