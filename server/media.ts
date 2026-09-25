import { fileTypeFromBuffer } from "file-type";
import { AppError } from "./errors.js";

const formats: Record<string, { mime: string; kind: "image" | "video"; detected: readonly string[] }> = {
  jpg: { mime: "image/jpeg", kind: "image", detected: ["jpg"] },
  jpeg: { mime: "image/jpeg", kind: "image", detected: ["jpg"] },
  png: { mime: "image/png", kind: "image", detected: ["png", "apng"] },
  gif: { mime: "image/gif", kind: "image", detected: ["gif"] },
  webp: { mime: "image/webp", kind: "image", detected: ["webp"] },
  heic: { mime: "image/heic", kind: "image", detected: ["heic", "heif"] },
  heif: { mime: "image/heif", kind: "image", detected: ["heic", "heif"] },
  avif: { mime: "image/avif", kind: "image", detected: ["avif"] },
  mp4: { mime: "video/mp4", kind: "video", detected: ["mp4", "m4v"] },
  m4v: { mime: "video/mp4", kind: "video", detected: ["mp4", "m4v"] },
  mov: { mime: "video/quicktime", kind: "video", detected: ["mov", "mp4"] },
  webm: { mime: "video/webm", kind: "video", detected: ["webm"] },
  "3gp": { mime: "video/3gpp", kind: "video", detected: ["3gp"] },
};

export function extensionOf(name: string): string {
  return name.slice(name.lastIndexOf(".") + 1).toLowerCase();
}

export function mediaInfo(name: string): { mime: string; kind: "image" | "video" | "other" } {
  const ext = extensionOf(name);
  return (Object.hasOwn(formats, ext) ? formats[ext] : undefined) ?? { mime: "application/octet-stream", kind: "other" };
}

export function safeUploadName(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 200 || /[\\/\u0000-\u001f\u007f]/u.test(value)) {
    throw new AppError(400, "INVALID_FILENAME", "Nome del file non valido.");
  }
  const ext = extensionOf(value);
  if (value.lastIndexOf(".") <= 0 || !Object.hasOwn(formats, ext)) {
    throw new AppError(415, "UNSUPPORTED_MEDIA", "Formato non supportato. Seleziona una foto o un video nei formati indicati.");
  }
  const stem = value.slice(0, value.lastIndexOf(".")).normalize("NFKC")
    .replace(/[^\p{L}\p{N} _-]/gu, "_").trim().slice(0, 120) || "materiale";
  return `${stem}.${ext}`;
}

export async function verifyMediaHeader(name: string, data: Buffer): Promise<void> {
  let detected;
  try {
    detected = await fileTypeFromBuffer(data);
  } catch (error) {
    if (!(error instanceof Error) || error.name !== "EndOfStreamError") throw error;
    throw new AppError(415, "INVALID_MEDIA", "Il file e' incompleto o non e' una foto/video valido.");
  }
  const ext = extensionOf(name);
  const format = Object.hasOwn(formats, ext) ? formats[ext] : undefined;
  if (!format || !detected || !format.detected.includes(detected.ext) ||
      !detected.mime.startsWith(`${format.kind}/`)) {
    throw new AppError(415, "INVALID_MEDIA", "Il contenuto del file non corrisponde al formato dichiarato.");
  }
}
