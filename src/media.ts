import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { ApiError } from "./domain";

export const BUCKET = "content";

/** What the app is allowed to upload, and the extension each gets stored under. */
const MIME: Record<string, { ext: string; kind: "image" | "video" }> = {
  "image/jpeg": { ext: "jpg", kind: "image" },
  "image/png": { ext: "png", kind: "image" },
  "image/webp": { ext: "webp", kind: "image" },
  "image/heic": { ext: "heic", kind: "image" },
  "video/mp4": { ext: "mp4", kind: "video" },
  "video/quicktime": { ext: "mov", kind: "video" },
};

export type UploadTicket = {
  /** Object path inside the bucket, echoed back when the post is created. */
  path: string;
  /** PUT the file bytes here. Expires in a couple of minutes. */
  uploadUrl: string;
  /** Where the file will be readable once uploaded. */
  publicUrl: string;
  kind: "image" | "video";
};

export interface MediaStore {
  /** A one-shot upload URL, so big files never pass through this process. */
  createUploadTicket(userId: string, contentType: string): Promise<UploadTicket>;
  /** Confirms the object is actually there before a post is allowed to reference it. */
  exists(path: string): Promise<boolean>;
  publicUrl(path: string): string;
}

export function mimeKind(contentType: string): "image" | "video" {
  const entry = MIME[contentType.toLowerCase()];
  if (!entry) {
    throw new ApiError(415, `unsupported media type: ${contentType}`);
  }
  return entry.kind;
}

/** Objects live under the uploader's own prefix, so nobody can claim another's file. */
export function pathBelongsTo(path: string, userId: string): boolean {
  return path.startsWith(`u/${userId}/`) && !path.includes("..");
}

export class SupabaseMediaStore implements MediaStore {
  private readonly db: SupabaseClient;

  constructor(
    private readonly url: string,
    serviceKey: string,
  ) {
    this.db = createClient(url, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }

  async createUploadTicket(userId: string, contentType: string): Promise<UploadTicket> {
    const entry = MIME[contentType.toLowerCase()];
    if (!entry) throw new ApiError(415, `unsupported media type: ${contentType}`);

    const path = `u/${userId}/${randomUUID()}.${entry.ext}`;
    const { data, error } = await this.db.storage.from(BUCKET).createSignedUploadUrl(path);
    if (error || !data) throw new ApiError(502, `could not create upload url: ${error?.message}`);

    return {
      path,
      uploadUrl: data.signedUrl,
      publicUrl: this.publicUrl(path),
      kind: entry.kind,
    };
  }

  async exists(path: string): Promise<boolean> {
    const res = await fetch(this.publicUrl(path), { method: "HEAD" });
    return res.ok;
  }

  publicUrl(path: string): string {
    return `${this.url}/storage/v1/object/public/${BUCKET}/${path}`;
  }
}

/** In-memory mode has nowhere to put files; say so rather than pretending. */
export class NullMediaStore implements MediaStore {
  async createUploadTicket(): Promise<UploadTicket> {
    throw new ApiError(501, "media uploads need STORE=supabase");
  }
  async exists(): Promise<boolean> {
    return false;
  }
  publicUrl(path: string): string {
    return path;
  }
}
