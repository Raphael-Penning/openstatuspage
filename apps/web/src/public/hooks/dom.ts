/**
 * Small DOM related hooks of the public page.
 */
import { useEffect, useSyncExternalStore, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { usePublicSettings } from './queries';

/** Sets document.title to "<page> · <site name>" (or just the site name). */
export function useDocumentTitle(page?: string | null): void {
  const { t } = useTranslation('public');
  const { data } = usePublicSettings();
  const site = data?.siteName ?? t('fallbackSiteName');
  useEffect(() => {
    document.title = page ? `${page} · ${site}` : site;
  }, [page, site]);
}

function subscribeResize(cb: () => void): () => void {
  window.addEventListener('resize', cb);
  return () => window.removeEventListener('resize', cb);
}

/** Current viewport width, updated on resize. */
export function useViewportWidth(): number {
  return useSyncExternalStore(
    subscribeResize,
    () => window.innerWidth,
    () => 1280,
  );
}

/** Closes a popover on outside click and on Escape. */
export function useDismiss(
  open: boolean,
  ref: RefObject<HTMLElement | null>,
  onClose: () => void,
): void {
  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, ref, onClose]);
}
