import { AppError } from "./errors.js";

export const STAGING_PREFIX = ".upload-";

export function relativePath(value: unknown, allowEmpty = true): string {
  if (typeof value !== "string" || value.length > 1024 ||
      /[\\%?#\u0000-\u001f\u007f]/u.test(value)) {
    throw new AppError(400, "INVALID_PATH", "Percorso non valido.");
  }
  if (value === "" && allowEmpty) return value;
  const parts = value.split("/");
  if (parts.some((part) => part === "" || part === "." || part === ".." ||
      part.length > 255 || part.startsWith(STAGING_PREFIX))) {
    throw new AppError(400, "INVALID_PATH", "Percorso non valido.");
  }
  return value;
}

export function joinPath(folder: string, name: string): string {
  return folder && name ? `${folder}/${name}` : folder || name;
}

export function fileNameOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

export function isVisiblePath(path: string): boolean {
  return !path.split("/").some((part) => part.startsWith(STAGING_PREFIX));
}
