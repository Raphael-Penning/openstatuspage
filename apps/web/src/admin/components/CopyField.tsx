import { Check, Copy } from 'lucide-react';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { inputClass } from './fields';
import { useToast } from './Toast';
import { Button } from './ui';

/** Read-only value with a copy-to-clipboard button. */
export function CopyField({ label, value, secret }: { label: string; value: string; secret?: boolean }) {
  const { t } = useTranslation('admin');
  const toast = useToast();
  const id = useId();
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API unavailable (e.g. insecure context): select the text for manual copying.
      (document.getElementById(id) as HTMLInputElement | null)?.select();
      toast.info(t('copy.manual'));
    }
  };

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      <div className="flex gap-2">
        <input
          id={id}
          readOnly
          value={value}
          onFocus={(e) => e.currentTarget.select()}
          className={`${inputClass} font-mono text-xs ${secret ? 'tracking-tight' : ''}`}
          spellCheck={false}
        />
        <Button onClick={() => void copy()} icon={copied ? Check : Copy} aria-label={t('copy.copyLabel', { label })}>
          {copied ? t('copy.copied') : t('copy.copy')}
        </Button>
      </div>
    </div>
  );
}
