/**
 * Modal dialog based on the native <dialog> element (focus trap, Escape to
 * close and inert background for free) plus a confirmation dialog.
 */
import { X } from 'lucide-react';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from './ui';

interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  /** Wider layout for forms. */
  wide?: boolean;
}

export function Dialog({ open, onClose, title, children, footer, wide }: DialogProps) {
  const { t } = useTranslation('admin');
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        // Click on the backdrop closes the dialog.
        if (e.target === ref.current) onClose();
      }}
      className={
        'm-auto w-[calc(100%-2rem)] rounded-2xl border border-border bg-surface p-0 text-fg shadow-xl backdrop:bg-black/50 ' +
        (wide ? 'max-w-2xl' : 'max-w-md')
      }
    >
      {open && (
        <div className="flex max-h-[85vh] flex-col">
          <div className="flex items-center justify-between gap-4 border-b border-border px-5 py-4">
            <h2 id={titleId} className="text-base font-semibold">
              {title}
            </h2>
            <button
              type="button"
              onClick={onClose}
              className="rounded-md p-1 text-muted hover:bg-surface-2 hover:text-fg focus-visible:outline-2 focus-visible:outline-accent"
              aria-label={t('common:actions.close')}
            >
              <X aria-hidden className="size-4" />
            </button>
          </div>
          <div className="overflow-y-auto px-5 py-4">{children}</div>
          {footer && <div className="flex flex-wrap justify-end gap-2 border-t border-border px-5 py-3">{footer}</div>}
        </div>
      )}
    </dialog>
  );
}

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  pending?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({ open, title, message, confirmLabel, danger = true, pending, onConfirm, onCancel }: ConfirmDialogProps) {
  const { t } = useTranslation('admin');
  return (
    <Dialog
      open={open}
      onClose={onCancel}
      title={title}
      footer={
        <>
          <Button variant="secondary" onClick={onCancel} disabled={pending}>
            {t('common:actions.cancel')}
          </Button>
          <Button variant={danger ? 'danger' : 'primary'} onClick={onConfirm} pending={pending}>
            {confirmLabel ?? t('common:actions.delete')}
          </Button>
        </>
      }
    >
      <div className="text-sm text-muted">{message}</div>
    </Dialog>
  );
}

/**
 * Hook for a confirmation step before a destructive action:
 * `const confirm = useConfirm(); confirm.ask({...}); <ConfirmDialog {...confirm.props} />`.
 */
export function useConfirm() {
  const [state, setState] = useState<{
    title: string;
    message: ReactNode;
    confirmLabel?: string;
    danger?: boolean;
    action: () => void;
  } | null>(null);
  return {
    ask: (opts: { title: string; message: ReactNode; confirmLabel?: string; danger?: boolean; action: () => void }) =>
      setState(opts),
    close: () => setState(null),
    dialogProps: (pending?: boolean): ConfirmDialogProps => ({
      open: state !== null,
      title: state?.title ?? '',
      message: state?.message ?? '',
      confirmLabel: state?.confirmLabel,
      danger: state?.danger ?? true,
      pending,
      onConfirm: () => state?.action(),
      onCancel: () => setState(null),
    }),
  };
}
