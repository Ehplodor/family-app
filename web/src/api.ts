export type Member = { id: string; name: string; color: string };

export type FamilySettings = {
  /** Modules affichés sur l'accueil, dans l'ordre. */
  homeModules?: string[];
  /** Couleur d'accent de l'application. */
  accent?: string;
};

export type Family = { id: string; name: string; inviteCode: string; settings: FamilySettings };

export type Me = { member: Member; family: Family; members: Member[] };

export type Doc<T> = T & { id: string; createdBy: string | null; createdAt: string; updatedAt: string };

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    credentials: 'same-origin',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error || `Erreur ${res.status}`);
  return data as T;
}

export async function uploadImage(blob: Blob): Promise<{ id: string; url: string }> {
  const res = await fetch('/api/files', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': blob.type },
    body: blob,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error || `Erreur ${res.status}`);
  return data;
}

export const fileUrl = (id: string) => `/api/files/${id}`;
