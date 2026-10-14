import { Check, Copy } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useT } from '../i18n/I18nProvider';

export function CopyButton({ text }: { text: string }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const id = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(id);
  }, [copied]);
  const copy = () => {
    navigator.clipboard?.writeText(text).then(
      () => setCopied(true),
      () => undefined,
    );
  };
  const label = copied ? t('quickstart.copied') : t('quickstart.copy');
  return (
    <button type="button" className={`copy-btn ${copied ? 'is-copied' : ''}`} onClick={copy} aria-label={label} title={label}>
      {copied ? <Check size={15} /> : <Copy size={15} />}
      <span aria-live="polite">{label}</span>
    </button>
  );
}
