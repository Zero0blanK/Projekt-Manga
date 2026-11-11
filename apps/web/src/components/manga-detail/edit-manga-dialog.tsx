'use client';

import { useEffect, useId, useRef, useState, type ChangeEvent, type ReactNode } from 'react';
import { SelectMenu } from '@/components/ui/select-menu';
import { useRouter } from 'next/navigation';
import { Pencil } from 'lucide-react';
import {
  removeMangaCover,
  resetMangaOverride,
  updateMangaOverride,
  uploadMangaCover,
  type UpdateMangaOverridePayload,
} from '@projekt-manga/api-client';
import { MANGA_COVER_MIME_TYPES } from '@projekt-manga/schemas';
import { coverFileProblem } from '@/lib/cover-file';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { toast } from '@/hooks/use-toast';
import { queryClient, queryKeys } from '@/lib/query-client';
import type { Manga } from '@/lib/manga-data';

const STATUS_OPTIONS = [
  { value: 'ONGOING', label: 'Ongoing' },
  { value: 'COMPLETED', label: 'Completed' },
  { value: 'HIATUS', label: 'Hiatus' },
  { value: 'CANCELLED', label: 'Cancelled' },
  { value: 'UNKNOWN', label: 'Unknown' },
] as const;

// The settings controls' look, so the dialog reads as part of the same app.
const inputClass =
  'w-full rounded-lg border border-border/60 bg-background px-3 py-1.5 text-sm text-foreground outline-none focus:border-primary/60 disabled:opacity-60';
const buttonClass =
  'rounded-lg border border-border/60 px-3 py-1.5 text-xs font-medium text-foreground transition hover:bg-accent disabled:opacity-50';
const destructiveButtonClass =
  'rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-1.5 text-xs font-medium text-destructive transition hover:bg-destructive/20 disabled:opacity-50';

type Values = { title: string; author: string; description: string; status: string };

function EditField({
  label,
  source,
  edited,
  children,
}: {
  label: string;
  /** The source's own value, shown once the field has been edited. */
  source: string | null | undefined;
  edited: boolean;
  children: (id: string) => ReactNode;
}) {
  const id = useId();
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="text-sm font-medium text-foreground">
        {label}
      </label>
      {children(id)}
      {edited && (
        <p className="line-clamp-2 text-xs text-muted-foreground">
          Source: {source?.trim() ? source : '—'}
        </p>
      )}
    </div>
  );
}

/**
 * Only fields the reader actually changed are sent. One left equal to the source's own
 * value, or emptied, is sent as null so the source's value shows through again and later
 * updates to it are not masked by a copy.
 */
function changedFields(
  values: Values,
  current: Values,
  original: Values,
): UpdateMangaOverridePayload {
  const payload: UpdateMangaOverridePayload = {};
  for (const key of ['title', 'author', 'description', 'status'] as const) {
    const next = key === 'description' ? values[key] : values[key].trim();
    if (next === current[key]) continue;
    payload[key] = next === '' || next === original[key] ? null : next;
  }
  return payload;
}

/**
 * Lets a reader change how a title looks in their own library — cover, title, author,
 * description, status — without touching the shared catalog. Library updates keep
 * refreshing the source's values underneath; "Reset to source" shows them again.
 */
export function EditMangaDialog({ manga }: { manga: Manga }) {
  const router = useRouter();
  const editable = manga.editable;
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState<Values | null>(null);
  const [cover, setCover] = useState<{ file: File; preview: string } | null>(null);
  const [removeCover, setRemoveCover] = useState(false);
  const [busy, setBusy] = useState<'save' | 'reset' | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    return () => {
      if (cover) URL.revokeObjectURL(cover.preview);
    };
  }, [cover]);

  if (!editable) return null;
  const override = editable.override;
  const current: Values = {
    title: editable.title,
    author: editable.author,
    description: editable.description,
    status: editable.status,
  };
  const original: Values = override
    ? {
        title: override.original.title,
        author: override.original.author,
        description: override.original.description ?? '',
        status: override.original.status ?? '',
      }
    : current;
  const form = values ?? current;

  const onOpenChange = (next: boolean) => {
    if (busy) return;
    setOpen(next);
    if (next) {
      setValues(current);
      setCover(null);
      setRemoveCover(false);
    }
  };

  const set = (key: keyof Values) => (event: { target: { value: string } }) =>
    setValues({ ...form, [key]: event.target.value });

  const chooseCover = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    const problem = coverFileProblem(file);
    if (problem) {
      toast({ description: problem });
      return;
    }
    setCover({ file, preview: URL.createObjectURL(file) });
    setRemoveCover(false);
  };

  const finish = (message: string) => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.mangaLibrary });
    router.refresh();
    setOpen(false);
    toast({ description: message });
  };

  const save = async () => {
    const payload = changedFields(form, current, original);
    if (Object.keys(payload).length === 0 && !cover && !removeCover) {
      setOpen(false);
      return;
    }
    setBusy('save');
    try {
      if (Object.keys(payload).length > 0) await updateMangaOverride(manga.id, payload);
      if (cover) await uploadMangaCover(manga.id, cover.file);
      else if (removeCover) await removeMangaCover(manga.id);
      finish('Your edits are saved.');
    } catch (error) {
      toast({
        description:
          error instanceof Error && error.message
            ? `Couldn't save your edits: ${error.message}`
            : "Couldn't save your edits — try again.",
      });
    } finally {
      setBusy(null);
    }
  };

  const reset = async () => {
    setBusy('reset');
    try {
      await resetMangaOverride(manga.id);
      finish('Showing the source’s details again.');
    } catch {
      toast({ description: "Couldn't reset this title — try again." });
    } finally {
      setBusy(null);
    }
  };

  const coverPreview = cover?.preview ?? (removeCover ? null : manga.thumbnailUrl);
  const hasCustomCover = !removeCover && (cover !== null || override?.has_cover === true);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger
        aria-label="Edit details"
        title="Edit details"
        className="grid h-10 w-10 place-items-center rounded-full border border-border/60 bg-surface/60 text-foreground hover:bg-surface"
      >
        <Pencil className="h-4 w-4" />
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Edit details</DialogTitle>
          <DialogDescription>
            Only changes how this title looks for you. Library updates keep the source’s details
            underneath.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-5 sm:grid-cols-[8rem_minmax(0,1fr)]">
          <div className="space-y-2">
            <div
              className="aspect-[2/3] w-32 overflow-hidden rounded-lg border border-border/60 bg-muted"
              style={coverPreview ? undefined : { background: manga.color }}
            >
              {coverPreview && (
                // A local object URL or an API route; next/image cannot optimize either.
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={coverPreview}
                  alt="Cover preview"
                  className="h-full w-full object-cover"
                />
              )}
            </div>
            <input
              ref={fileInput}
              type="file"
              accept={MANGA_COVER_MIME_TYPES.join(',')}
              className="sr-only"
              aria-label="Choose a cover image"
              onChange={chooseCover}
              tabIndex={-1}
            />
            <div className="flex flex-col gap-1.5">
              <button
                type="button"
                className={buttonClass}
                disabled={busy !== null}
                onClick={() => fileInput.current?.click()}
              >
                Choose cover…
              </button>
              {hasCustomCover && (
                <button
                  type="button"
                  className={buttonClass}
                  disabled={busy !== null}
                  onClick={() => {
                    setCover(null);
                    setRemoveCover(override?.has_cover === true);
                  }}
                >
                  Use source cover
                </button>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              JPEG, PNG, GIF, WebP or AVIF, up to 5 MB.
            </p>
          </div>

          <div className="min-w-0 space-y-4">
            <EditField label="Title" source={original.title} edited={override?.title != null}>
              {(id) => (
                <input
                  id={id}
                  className={inputClass}
                  value={form.title}
                  maxLength={255}
                  placeholder={original.title}
                  disabled={busy !== null}
                  onChange={set('title')}
                />
              )}
            </EditField>
            <EditField label="Author" source={original.author} edited={override?.author != null}>
              {(id) => (
                <input
                  id={id}
                  className={inputClass}
                  value={form.author}
                  maxLength={255}
                  placeholder={original.author}
                  disabled={busy !== null}
                  onChange={set('author')}
                />
              )}
            </EditField>
            <EditField
              label="Status"
              source={STATUS_OPTIONS.find((o) => o.value === original.status)?.label}
              edited={override?.status != null}
            >
              {(id) => (
                <SelectMenu
                  id={id}
                  value={form.status}
                  disabled={busy !== null}
                  onChange={(value) => set('status')({ target: { value } })}
                  options={STATUS_OPTIONS}
                  className="w-full"
                />
              )}
            </EditField>
            <EditField
              label="Description"
              source={original.description}
              edited={override?.description != null}
            >
              {(id) => (
                <textarea
                  id={id}
                  className={`${inputClass} min-h-32 resize-y`}
                  value={form.description}
                  maxLength={20_000}
                  disabled={busy !== null}
                  onChange={set('description')}
                />
              )}
            </EditField>
          </div>
        </div>

        <DialogFooter className="gap-2 sm:justify-between">
          {override ? (
            <button
              type="button"
              className={destructiveButtonClass}
              disabled={busy !== null}
              onClick={reset}
            >
              {busy === 'reset' ? 'Resetting…' : 'Reset to source'}
            </button>
          ) : (
            <span />
          )}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              className={buttonClass}
              disabled={busy !== null}
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="rounded-lg border border-primary/50 bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-50"
              disabled={busy !== null}
              onClick={save}
            >
              {busy === 'save' ? 'Saving…' : 'Save'}
            </button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
