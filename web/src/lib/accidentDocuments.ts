import { REQUIRED_DOCS } from "./accidentWorkflow";

/** What the server says about each of the four core documents (Najm report, driver ID, licence, vehicle registration). */
export type DocumentSlot = {
  category: (typeof REQUIRED_DOCS)[number];
  status: "MISSING" | "UPLOADED";
  currentId: string | null;
  replacedCount: number;
  updatedAt: string | null;
};

export type DocumentFile = {
  id: string;
  category: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: string;
  supersededAt?: string | null;
  uploadedByName?: string | null;
};

export type DocumentRow = {
  category: string;
  status: DocumentSlot["status"];
  current: DocumentFile | null;
  /** Earlier files of this document, newest first (kept for the record, never deleted). */
  history: DocumentFile[];
};

export type FileKind = "pdf" | "image" | "other";
export const fileKind = (mime: string): FileKind => (mime === "application/pdf" ? "pdf" : /^image\/(png|jpeg|webp)$/.test(mime) ? "image" : "other");

/** 1536 -> "1.5 KB". Sizes come from the stored file, so this is only formatting. */
export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * One row per core document, in the server's order, joined with the files the caller may see.
 * Status and "current file" come from the server's slot; a file the caller may not see is simply not here (the slot reads as missing).
 */
export function documentRows(slots: readonly DocumentSlot[], files: readonly DocumentFile[]): DocumentRow[] {
  const byId = new Map(files.map((f) => [f.id, f]));
  return slots.map((slot) => {
    const current = slot.currentId ? (byId.get(slot.currentId) ?? null) : null;
    const history = files
      .filter((f) => f.category === slot.category && !!f.supersededAt)
      .sort((a, b) => +new Date(b.supersededAt ?? 0) - +new Date(a.supersededAt ?? 0));
    return { category: slot.category, status: current ? "UPLOADED" : "MISSING", current, history };
  });
}

/** Files that are not one of the four core documents and still count (not replaced). */
export const otherDocuments = (files: readonly DocumentFile[]): DocumentFile[] =>
  files.filter((f) => !(REQUIRED_DOCS as readonly string[]).includes(f.category) && !f.supersededAt);
