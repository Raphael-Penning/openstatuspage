/**
 * Uploads an image (PNG, JPEG, WebP, ICO, at most 1 MiB) to /api/admin/uploads.
 * A real file input inside its label: keyboard and screen reader users reach
 * it like any other control. The server checks the type by the file's bytes;
 * the checks here only spare a needless request.
 */
import { UPLOAD_MAX_BYTES, type AdminUpload } from '@openstatuspage/shared';
import { clsx } from 'clsx';
import { Upload } from 'lucide-react';
import { useId, type ChangeEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../lib/api';
import { useToast } from './Toast';
import { buttonClass, Spinner } from './ui';
import { useAdminMutation } from '../lib/queries';

/** File types the picker offers (the server decides by the bytes). */
export const UPLOAD_ACCEPT = 'image/png,image/jpeg,image/webp,image/x-icon,image/vnd.microsoft.icon,.ico';

export function UploadButton({
  label,
  onUploaded,
  size = 'md',
  className,
}: {
  label: string;
  onUploaded?: (upload: AdminUpload) => void;
  size?: 'sm' | 'md';
  className?: string;
}) {
  const { t } = useTranslation('admin');
  const toast = useToast();
  const id = useId();
  const upload = useAdminMutation(
    (file: File) => api.upload<AdminUpload>('/api/admin/uploads', file, { fileName: file.name.slice(0, 120) }),
    { success: t('uploads.uploaded'), onSuccess: (u) => onUploaded?.(u) },
  );

  const pick = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (file.size > UPLOAD_MAX_BYTES) {
      toast.error(t('uploads.tooLarge'));
      return;
    }
    upload.mutate(file);
  };

  return (
    <label htmlFor={id} className={clsx(buttonClass('secondary', size), 'cursor-pointer focus-within:outline-2 focus-within:outline-accent', className)}>
      {upload.isPending ? <Spinner className="size-4" /> : <Upload aria-hidden className="size-4" />}
      {label}
      <input id={id} type="file" accept={UPLOAD_ACCEPT} className="sr-only" onChange={pick} disabled={upload.isPending} />
    </label>
  );
}
