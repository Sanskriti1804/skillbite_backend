import { LIST_LIMIT } from "../deps.js";
import { HttpError } from "../errors.js";
import { encryptSecret, sha256 } from "../security.js";
import type { Access } from "./access.js";

export function createLearningService(access: Access) {
  const { prisma, config } = access;
  return {
    async bookmark(userId: string, contentId: string) {
      try {
        await prisma.bookmark.create({ data: { userId, contentId } });
      } catch {
        throw new HttpError(409, "conflict", "Already bookmarked");
      }
      return { contentId };
    },
    async removeBookmark(userId: string, contentId: string) {
      await prisma.bookmark.delete({ where: { userId_contentId: { userId, contentId } } });
      return { status: "ok" as const };
    },
    async bookmarks(userId: string) {
      const items = await prisma.bookmark.findMany({
        where: { userId },
        take: LIST_LIMIT,
        orderBy: { createdAt: "desc" },
        include: {
          content: {
            select: {
              contentId: true,
              contentType: true,
              title: true,
              description: true,
              status: true,
              deletedAt: true,
            },
          },
        },
      });
      return {
        limit: LIST_LIMIT,
        items: items
          .filter((row) => row.content && !row.content.deletedAt && row.content.status !== "REMOVED")
          .map((row) => ({
            contentId: row.content.contentId,
            contentType: row.content.contentType,
            title: row.content.title,
            description: row.content.description,
            status: row.content.status,
            createdAt: row.createdAt,
          })),
      };
    },

    async listComments(contentId: string) {
      const userSelect = {
        userId: true,
        usernameNormalized: true,
        displayName: true,
      } as const;
      // One flat query (+ tiny content check) instead of nested reply includes (extra Neon round-trips).
      const [content, rows] = await Promise.all([
        prisma.content.findFirst({
          where: { contentId, deletedAt: null, NOT: { status: "REMOVED" } },
          select: { contentId: true },
        }),
        prisma.comment.findMany({
          where: { contentId, deletedAt: null },
          orderBy: { createdAt: "asc" },
          take: 80,
          select: {
            commentId: true,
            contentId: true,
            parentCommentId: true,
            body: true,
            createdAt: true,
            user: { select: userSelect },
          },
        }),
      ]);
      if (!content) throw new HttpError(404, "not_found", "Not found");

      const mapComment = (row: (typeof rows)[number]) => ({
        commentId: row.commentId,
        contentId: row.contentId,
        parentCommentId: row.parentCommentId,
        body: row.body,
        createdAt: row.createdAt,
        userId: row.user.userId,
        username: row.user.usernameNormalized,
        displayName: row.user.displayName,
      });

      const roots: Array<ReturnType<typeof mapComment> & { replies: ReturnType<typeof mapComment>[] }> = [];
      const byId = new Map<string, (typeof roots)[number]>();
      for (const row of rows) {
        if (row.parentCommentId) continue;
        const mapped = { ...mapComment(row), replies: [] as ReturnType<typeof mapComment>[] };
        byId.set(mapped.commentId, mapped);
        roots.push(mapped);
      }
      for (const row of rows) {
        if (!row.parentCommentId) continue;
        const parent = byId.get(row.parentCommentId);
        if (parent) parent.replies.push(mapComment(row));
      }
      roots.reverse();
      return { limit: 80, total: rows.length, items: roots };
    },

    async addComment(userId: string, contentId: string, bodyRaw: unknown, parentCommentIdRaw?: unknown) {
      const body = typeof bodyRaw === "string" ? bodyRaw.trim() : "";
      if (!body) throw new HttpError(400, "validation", "Comment cannot be empty");
      if (body.length > 500) throw new HttpError(400, "validation", "Comment is too long");
      const content = await prisma.content.findUnique({ where: { contentId } });
      if (!content || content.deletedAt || content.status === "REMOVED") {
        throw new HttpError(404, "not_found", "Not found");
      }
      if (content.status !== "PUBLISHED") {
        throw new HttpError(403, "forbidden", "Comments are only allowed on published content");
      }

      let parentCommentId: string | null = null;
      const parentId = typeof parentCommentIdRaw === "string" ? parentCommentIdRaw.trim() : "";
      if (parentId) {
        const parent = await prisma.comment.findUnique({ where: { commentId: parentId } });
        if (!parent || parent.deletedAt || parent.contentId !== contentId) {
          throw new HttpError(404, "not_found", "Parent comment not found");
        }
        // One-level threads: replies always hang off the root comment.
        parentCommentId = parent.parentCommentId ?? parent.commentId;
      }

      const row = await prisma.comment.create({
        data: { contentId, userId, body, parentCommentId },
        include: {
          user: {
            select: {
              userId: true,
              usernameNormalized: true,
              displayName: true,
            },
          },
        },
      });
      if (content.creatorId !== userId) {
        await prisma.notification.create({
          data: {
            userId: content.creatorId,
            notificationType: "COMMENT",
            title: parentCommentId ? "New reply" : "New comment",
            message: `${row.user.displayName} ${parentCommentId ? "replied on" : "commented on"} your ${content.contentType === "COURSE" ? "course" : "short"}`,
            targetReference: contentId,
          },
        }).catch(() => undefined);
      }
      return {
        commentId: row.commentId,
        contentId: row.contentId,
        parentCommentId: row.parentCommentId,
        body: row.body,
        createdAt: row.createdAt,
        userId: row.user.userId,
        username: row.user.usernameNormalized,
        displayName: row.user.displayName,
        replies: [] as Array<never>,
      };
    },

    async deleteComment(userId: string, commentId: string) {
      const row = await prisma.comment.findUnique({
        where: { commentId },
        include: { content: { select: { creatorId: true } } },
      });
      if (!row || row.deletedAt) throw new HttpError(404, "not_found", "Not found");
      if (row.userId !== userId && row.content.creatorId !== userId) {
        throw new HttpError(403, "forbidden", "Not allowed");
      }
      const now = new Date();
      await prisma.comment.update({
        where: { commentId },
        data: { deletedAt: now },
      });
      if (!row.parentCommentId) {
        await prisma.comment.updateMany({
          where: { parentCommentId: commentId, deletedAt: null },
          data: { deletedAt: now },
        });
      }
      return { status: "ok" as const };
    },
    async saveProgress(userId: string, contentId: string, position: unknown) {
      const video = await prisma.videoDetails.findUnique({ where: { contentId } });
      if (!video) throw new HttpError(404, "not_found", "Not found");
      if (!Number.isInteger(position) || (position as number) < 0 || (position as number) > video.durationSeconds) {
        throw new HttpError(400, "validation", "Invalid position");
      }
      const existing = await prisma.videoProgress.findUnique({
        where: { userId_videoContentId: { userId, videoContentId: video.contentId } },
      });
      const row = existing
        ? await prisma.videoProgress.update({
            where: { progressId: existing.progressId },
            data: { lastPositionSeconds: position as number, lastWatchedAt: new Date() },
          })
        : await prisma.videoProgress.create({
            data: { userId, videoContentId: video.contentId, lastPositionSeconds: position as number, lastWatchedAt: new Date() },
          });
      return { lastPositionSeconds: row.lastPositionSeconds, completedAt: row.completedAt };
    },
    async progress(userId: string) {
      const items = await prisma.videoProgress.findMany({ where: { userId }, orderBy: { lastWatchedAt: "desc" }, take: LIST_LIMIT });
      return { limit: LIST_LIMIT, items };
    },
    async courseProgress(userId: string, contentId: string) {
      const modules = await prisma.courseModule.findMany({
        where: { courseContentId: contentId },
        include: { lessons: { include: { video: true } } },
      });
      const videos = modules.flatMap((module) => module.lessons.map((lesson) => lesson.video));
      const totalDurationSeconds = videos.reduce((sum, video) => sum + video.durationSeconds, 0);
      const progress = await prisma.videoProgress.findMany({
        where: { userId, videoContentId: { in: videos.map((video) => video.contentId) } },
      });
      const completedDurationSeconds = videos.reduce((sum, video) => {
        const row = progress.find((item) => item.videoContentId === video.contentId);
        return sum + (row?.completedAt ? video.durationSeconds : 0);
      }, 0);
      return { totalDurationSeconds, completedDurationSeconds };
    },
    async notifications(userId: string) {
      const items = await prisma.notification.findMany({ where: { userId }, orderBy: { createdAt: "desc" }, take: LIST_LIMIT });
      return { limit: LIST_LIMIT, items };
    },
    async markRead(userId: string, notificationId: string) {
      const row = await prisma.notification.findUnique({ where: { notificationId } });
      if (!row || row.userId !== userId) throw new HttpError(404, "not_found", "Not found");
      await prisma.notification.update({ where: { notificationId: row.notificationId }, data: { readAt: new Date() } });
      return { status: "ok" as const };
    },
    async preferences(userId: string) {
      const items = await prisma.notificationPreference.findMany({ where: { userId } });
      return { items };
    },
    preferenceUpdate(type: string) {
      const normalized = type.toLowerCase();
      if (normalized === "account" || normalized === "security") {
        throw new HttpError(409, "conflict", "Account and security messages cannot be disabled");
      }
      throw new HttpError(409, "conflict", "Notification types are not defined");
    },
    async registerDevice(userId: string, body: Record<string, unknown>) {
      if (!config.PUSH_TOKEN_KEY) throw new HttpError(500, "internal_error", "Internal error");
      const platform = body.platform;
      const pushToken = typeof body.pushToken === "string" ? body.pushToken : "";
      if ((platform !== "IOS" && platform !== "ANDROID" && platform !== "WEB") || !pushToken) {
        throw new HttpError(400, "validation", "Invalid device");
      }
      const device = await prisma.pushDevice.create({
        data: {
          userId,
          platform,
          encryptedPushToken: encryptSecret(config.PUSH_TOKEN_KEY, pushToken),
          tokenFingerprint: sha256(pushToken),
          lastRegisteredAt: new Date(),
        },
      });
      return { deviceId: device.deviceId };
    },
    async revokeDevice(userId: string, deviceId: string) {
      const device = await prisma.pushDevice.findUnique({ where: { deviceId } });
      if (!device || device.userId !== userId) throw new HttpError(404, "not_found", "Not found");
      await prisma.pushDevice.update({ where: { deviceId: device.deviceId }, data: { revokedAt: new Date() } });
      return { status: "ok" as const };
    },
  };
}
