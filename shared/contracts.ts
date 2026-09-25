export interface UserProfile {
  name: string;
  username: string;
}

export type SessionResponse =
  | { configured: false; missing: string[]; authenticated: false }
  | { configured: true; authenticated: false }
  | {
      configured: true;
      authenticated: true;
      user: UserProfile;
      folderLabel: string;
      maxUploadBytes: number;
      chunkSize: number;
      csrfToken: string;
    };

export interface FileEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
  lastModified: string | null;
  mediaType: "image" | "video" | "other";
}

export interface FilesResponse {
  path: string;
  entries: FileEntry[];
  nextCursor: string | null;
}

export interface StartUploadRequest {
  path: string;
  fileName: string;
  size: number;
}

export interface UploadResponse {
  id: string;
  offset: number;
  chunkSize: number;
}

export interface UploadCompleteResponse {
  file: FileEntry;
}

export interface ApiErrorResponse {
  error: {
    code: string;
    message: string;
    requestId?: string;
  };
}
