import { useRef, useState } from 'react';
import { Camera, ChevronLeft, ChevronRight, ImagePlus, Trash2, X } from 'lucide-react';
import { useCollection, useMembers } from '../store';
import { fileUrl, uploadImage, type Doc } from '../api';
import { fmt } from '../dates';
import { Empty, Page, confirmDelete } from '../ui';

export type Photo = { fileId: string; caption?: string };

export function GallerySummary() {
  const { docs } = useCollection<Photo>('photos');
  return <>{docs.length ? `${docs.length} photo${docs.length > 1 ? 's' : ''}` : 'Aucune photo'}</>;
}

/** Réduit les photos avant l'envoi (plus rapide, moins de stockage). */
async function shrink(file: File, max = 2000): Promise<Blob> {
  if (file.type === 'image/gif') return file;
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return await new Promise((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('conversion'))), 'image/jpeg', 0.85),
    );
  } catch {
    return file;
  }
}

export function GalleryPage() {
  const photos = useCollection<Photo>('photos');
  const { byId } = useMembers();
  const input = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(0);
  const [error, setError] = useState('');
  const [open, setOpen] = useState<number | null>(null);

  const sorted = [...photos.docs].reverse(); // les plus récentes d'abord

  const onFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    setError('');
    setUploading(files.length);
    for (const file of Array.from(files)) {
      try {
        const { id } = await uploadImage(await shrink(file));
        await photos.create({ fileId: id, caption: '' });
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Envoi impossible');
      }
      setUploading((n) => n - 1);
    }
    if (input.current) input.current.value = '';
  };

  const current: Doc<Photo> | undefined = open !== null ? sorted[open] : undefined;

  return (
    <Page
      title="Galerie"
      actions={
        <button className="btn small primary" onClick={() => input.current?.click()} disabled={uploading > 0}>
          <ImagePlus size={18} /> {uploading ? `Envoi (${uploading})…` : 'Ajouter'}
        </button>
      }
    >
      <input ref={input} type="file" accept="image/*" multiple hidden onChange={(e) => onFiles(e.target.files)} />
      {error && <p className="error">{error}</p>}
      {photos.loaded && !sorted.length && <Empty icon={<Camera size={48} />}>Partagez vos photos de famille.</Empty>}
      <div className="gallery">
        {sorted.map((p, i) => (
          <button key={p.id} onClick={() => setOpen(i)}>
            <img src={fileUrl(p.fileId)} alt={p.caption || ''} loading="lazy" />
          </button>
        ))}
      </div>

      {current && open !== null && (
        <div className="viewer" onClick={() => setOpen(null)}>
          <div className="viewer-top" onClick={(e) => e.stopPropagation()}>
            <span>
              {byId(current.createdBy)?.name ?? '—'} · {fmt(new Date(current.createdAt), { day: 'numeric', month: 'long', year: 'numeric' })}
            </span>
            <button
              className="icon-btn"
              aria-label="Supprimer"
              onClick={() => {
                if (confirmDelete('cette photo')) {
                  photos.remove(current.id);
                  setOpen(null);
                }
              }}
            >
              <Trash2 />
            </button>
            <button className="icon-btn" onClick={() => setOpen(null)} aria-label="Fermer">
              <X />
            </button>
          </div>
          <img src={fileUrl(current.fileId)} alt={current.caption || ''} onClick={(e) => e.stopPropagation()} />
          {open > 0 && (
            <button className="viewer-nav left" onClick={(e) => (e.stopPropagation(), setOpen(open - 1))} aria-label="Précédente">
              <ChevronLeft size={32} />
            </button>
          )}
          {open < sorted.length - 1 && (
            <button className="viewer-nav right" onClick={(e) => (e.stopPropagation(), setOpen(open + 1))} aria-label="Suivante">
              <ChevronRight size={32} />
            </button>
          )}
          <input
            key={current.id}
            className="viewer-caption"
            defaultValue={current.caption}
            placeholder="Ajouter une légende…"
            onClick={(e) => e.stopPropagation()}
            onBlur={(e) => e.target.value !== (current.caption ?? '') && photos.update(current.id, { caption: e.target.value })}
          />
        </div>
      )}
    </Page>
  );
}
