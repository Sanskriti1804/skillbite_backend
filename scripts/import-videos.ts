import "dotenv/config";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { v2 as cloudinary } from "cloudinary";
import { PrismaClient } from "@prisma/client";
import { loadConfig } from "../src/config.js";
import { seedReferenceData } from "../src/db/seed.js";
import { CLOUDINARY_REF_PREFIX, categoryFolderSlug, cloudinaryConfigFromEnv } from "../src/storage.js";

type ImportManifest = {
  sourceRoot: string;
  videos: Array<{
    file: string;
    categorySlug: string;
    creatorUsername: string;
    tags: string[];
    description: string;
    skip?: boolean;
  }>;
};

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(rootDir, "..");
const manifestPath = path.resolve(repoRoot, "download 2", "videos-import.json");

function slugifyTag(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "tag";
}

function titleFromDescription(description: string): string {
  const trimmed = description.trim();
  if (!trimmed) return "Untitled";
  return trimmed.length > 80 ? `${trimmed.slice(0, 77)}...` : trimmed;
}

async function main() {
  if (!existsSync(manifestPath)) {
    throw new Error(`Manifest not found: ${manifestPath}`);
  }
  const config = loadConfig();
  const cloudinaryCfg = cloudinaryConfigFromEnv(config);
  if (!cloudinaryCfg) {
    throw new Error("Cloudinary credentials are required in .env");
  }
  cloudinary.config({
    cloud_name: cloudinaryCfg.cloudName,
    api_key: cloudinaryCfg.apiKey,
    api_secret: cloudinaryCfg.apiSecret,
    secure: true,
  });

  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as ImportManifest;
  const sourceRoot = path.resolve(repoRoot, manifest.sourceRoot);
  const prisma = new PrismaClient({ datasources: { db: { url: config.DATABASE_URL } } });

  try {
    await seedReferenceData(prisma);
    const videos = manifest.videos.filter((item) => !item.skip);
    console.log(`Importing ${videos.length} videos from ${sourceRoot}`);

    let ok = 0;
    let failed = 0;

    for (const [index, item] of videos.entries()) {
      const label = `[${index + 1}/${videos.length}] ${item.file}`;
      try {
        const absolute = path.resolve(sourceRoot, item.file);
        if (!existsSync(absolute)) {
          throw new Error(`File missing: ${absolute}`);
        }

        const creator = await prisma.appUser.findUnique({
          where: { usernameNormalized: item.creatorUsername.trim().toLowerCase() },
        });
        if (!creator) {
          throw new Error(`Creator not found: ${item.creatorUsername}`);
        }

        const categoryName = item.categorySlug
          .split("-")
          .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
          .join(" ");
        const category = await prisma.category.upsert({
          where: { slug: item.categorySlug },
          update: { name: categoryName, isActive: true },
          create: { name: categoryName, slug: item.categorySlug, isActive: true },
        });

        const tagIds: string[] = [];
        for (const tagName of item.tags) {
          const slug = slugifyTag(tagName);
          const tag = await prisma.tag.upsert({
            where: { slug },
            update: { name: tagName },
            create: { name: tagName, slug },
          });
          tagIds.push(tag.tagId);
        }

        const description = item.description.trim();
        const content = await prisma.content.create({
          data: {
            creatorId: creator.userId,
            contentType: "VIDEO",
            title: titleFromDescription(description),
            description,
            keywords: item.tags.join(", "),
            status: "DRAFT",
            video: {
              create: {
                mediaReference: "",
                durationSeconds: 0,
                sources: "Imported creator material",
              },
            },
          },
        });

        const publicId = `${cloudinaryCfg.folder}/${categoryFolderSlug(item.categorySlug)}/${content.contentId}`
          .replaceAll(/\/+/g, "/");
        console.log(`${label} uploading to Cloudinary…`);
        await cloudinary.uploader.upload(absolute, {
          resource_type: "video",
          public_id: publicId,
          overwrite: true,
          invalidate: true,
        });
        const mediaReference = `${CLOUDINARY_REF_PREFIX}${publicId}`;

        await prisma.$transaction([
          prisma.videoDetails.update({
            where: { contentId: content.contentId },
            data: { mediaReference },
          }),
          prisma.contentCategory.create({
            data: { contentId: content.contentId, categoryId: category.categoryId },
          }),
          ...tagIds.map((tagId) =>
            prisma.contentTag.create({ data: { contentId: content.contentId, tagId } }),
          ),
          prisma.content.update({
            where: { contentId: content.contentId },
            data: { status: "PUBLISHED", publishedAt: new Date() },
          }),
        ]);

        ok += 1;
        console.log(`${label} published as ${content.contentId} (@${item.creatorUsername})`);
      } catch (error) {
        failed += 1;
        console.error(`${label} FAILED`, error instanceof Error ? error.message : error);
      }
    }

    console.log(`Done. imported=${ok} failed=${failed}`);
    if (failed > 0) process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
