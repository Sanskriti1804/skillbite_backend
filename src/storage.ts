import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { v2 as cloudinary } from "cloudinary";
import type { AppConfig } from "./config.js";

export const CLOUDINARY_REF_PREFIX = "cloudinary:";

export type SaveVideoOptions = {
  categorySlug?: string;
};

export type PlaybackQuality = "feed" | "full";

export interface MediaStorage {
  saveVideo(contentId: string, bytes: Buffer, options?: SaveVideoOptions): Promise<string>;
  read(reference: string): Promise<Buffer>;
  /** Direct playable URL when available (Cloudinary CDN). Null for local-only files. */
  playbackUrl(reference: string, quality?: PlaybackQuality): string | null;
  /** Still-frame preview for grids. Null when not available. */
  thumbnailUrl(reference: string): string | null;
}

export type CloudinaryConfig = {
  cloudName: string;
  apiKey: string;
  apiSecret: string;
  folder: string;
};

export function categoryFolderSlug(input?: string): string {
  const raw = (input ?? "uncategorized").trim().toLowerCase();
  const slug = raw.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug || "uncategorized";
}

export function localMediaStorage(root: string): MediaStorage {
  return {
    async saveVideo(contentId: string, bytes: Buffer, options?: SaveVideoOptions): Promise<string> {
      await mkdir(root, { recursive: true });
      const folder = categoryFolderSlug(options?.categorySlug);
      const reference = path.join(folder, contentId, "video.bin").replaceAll("\\", "/");
      const target = path.join(root, reference);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, bytes);
      return reference;
    },
    async read(reference: string): Promise<Buffer> {
      const rootPath = path.resolve(root);
      const target = path.resolve(rootPath, reference);
      const relative = path.relative(rootPath, target);
      if (relative.startsWith("..") || path.isAbsolute(relative)) {
        throw new Error("invalid reference");
      }
      return readFile(target);
    },
    playbackUrl() {
      return null;
    },
    thumbnailUrl() {
      return null;
    },
  };
}

export function cloudinaryMediaStorage(config: CloudinaryConfig): MediaStorage {
  cloudinary.config({
    cloud_name: config.cloudName,
    api_key: config.apiKey,
    api_secret: config.apiSecret,
    secure: true,
  });

  function publicIdFor(contentId: string, categorySlug?: string): string {
    return `${config.folder}/${categoryFolderSlug(categorySlug)}/${contentId}`.replaceAll(/\/+/g, "/");
  }

  function deliveryUrl(publicId: string, quality: PlaybackQuality): string {
    const transformation =
      quality === "feed"
        ? [
            {
              width: 720,
              crop: "limit",
              quality: "auto:eco",
              video_codec: "h264",
              bit_rate: "800k",
              fetch_format: "mp4",
            },
          ]
        : [
            {
              width: 1080,
              crop: "limit",
              quality: "auto:good",
              video_codec: "h264",
              fetch_format: "mp4",
            },
          ];
    return cloudinary.url(publicId, {
      resource_type: "video",
      type: "upload",
      secure: true,
      sign_url: true,
      transformation,
    });
  }

  function stillUrl(publicId: string): string {
    return cloudinary.url(publicId, {
      resource_type: "video",
      type: "upload",
      secure: true,
      sign_url: true,
      format: "jpg",
      transformation: [
        { start_offset: "auto" },
        { width: 480, height: 720, crop: "fill", gravity: "auto" },
        { quality: "auto:eco" },
      ],
    });
  }

  return {
    async saveVideo(contentId: string, bytes: Buffer, options?: SaveVideoOptions): Promise<string> {
      const publicId = publicIdFor(contentId, options?.categorySlug);
      await new Promise<void>((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
          {
            resource_type: "video",
            public_id: publicId,
            overwrite: true,
            invalidate: true,
            eager: [
              {
                width: 720,
                crop: "limit",
                quality: "auto:eco",
                video_codec: "h264",
                bit_rate: "800k",
                format: "mp4",
              },
            ],
            eager_async: true,
          },
          (error, result) => {
            if (error || !result?.public_id) {
              reject(error ?? new Error("Cloudinary upload failed"));
              return;
            }
            resolve();
          },
        );
        stream.end(bytes);
      });
      return `${CLOUDINARY_REF_PREFIX}${publicId}`;
    },
    async read(reference: string): Promise<Buffer> {
      if (!reference.startsWith(CLOUDINARY_REF_PREFIX)) {
        throw new Error("invalid cloudinary reference");
      }
      const publicId = reference.slice(CLOUDINARY_REF_PREFIX.length);
      const url = deliveryUrl(publicId, "full");
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error("Cloudinary media missing");
      }
      return Buffer.from(await response.arrayBuffer());
    },
    playbackUrl(reference: string, quality: PlaybackQuality = "feed"): string | null {
      if (!reference.startsWith(CLOUDINARY_REF_PREFIX)) return null;
      const publicId = reference.slice(CLOUDINARY_REF_PREFIX.length);
      return deliveryUrl(publicId, quality);
    },
    thumbnailUrl(reference: string): string | null {
      if (!reference.startsWith(CLOUDINARY_REF_PREFIX)) return null;
      const publicId = reference.slice(CLOUDINARY_REF_PREFIX.length);
      return stillUrl(publicId);
    },
  };
}

export function cloudinaryConfigFromEnv(config: AppConfig): CloudinaryConfig | null {
  const cloudName = config.CLOUDINARY_CLOUD_NAME?.trim();
  const apiKey = config.CLOUDINARY_API_KEY?.trim();
  const apiSecret = config.CLOUDINARY_API_SECRET?.trim();
  if (!cloudName || !apiKey || !apiSecret) return null;
  return {
    cloudName,
    apiKey,
    apiSecret,
    folder: (config.CLOUDINARY_FOLDER?.trim() || "skillbite").replace(/^\/+|\/+$/g, ""),
  };
}

/** Prefer Cloudinary when credentials are set; keep local reads for older references. */
export function createMediaStorage(config: AppConfig): MediaStorage {
  const local = localMediaStorage(config.MEDIA_ROOT);
  const cloudinaryCfg = cloudinaryConfigFromEnv(config);
  if (!cloudinaryCfg) return local;
  const remote = cloudinaryMediaStorage(cloudinaryCfg);
  return {
    async saveVideo(contentId: string, bytes: Buffer, options?: SaveVideoOptions): Promise<string> {
      return remote.saveVideo(contentId, bytes, options);
    },
    async read(reference: string): Promise<Buffer> {
      if (reference.startsWith(CLOUDINARY_REF_PREFIX)) {
        return remote.read(reference);
      }
      return local.read(reference);
    },
    playbackUrl(reference: string, quality?: PlaybackQuality): string | null {
      if (reference.startsWith(CLOUDINARY_REF_PREFIX)) {
        return remote.playbackUrl(reference, quality);
      }
      return local.playbackUrl(reference, quality);
    },
    thumbnailUrl(reference: string): string | null {
      if (reference.startsWith(CLOUDINARY_REF_PREFIX)) {
        return remote.thumbnailUrl(reference);
      }
      return local.thumbnailUrl(reference);
    },
  };
}
