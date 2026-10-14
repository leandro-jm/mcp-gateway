import { payloadOf, ThemeScope, ToolView, type ToolResultLike, type ViewHost } from '@mcp-ui-kit/components';
import '@mcp-ui-kit/components/styles.css';
import type { ThemeTokens } from '@mcp-ui-kit/view-spec';
import { useMemo } from 'react';
import { api } from '../api/client';
import type { PlaygroundResult } from '../api/types';
import { getLocale, useT } from '../i18n';
import { useTheme } from '../theme/theme';
import { useToast } from './toast';

export interface PreviewSubject {
  sub: string;
  roles: string[];
  groups?: string[];
  claims?: Record<string, unknown>;
}

/**
 * Renders a tool result the way an MCP Apps host would (ADR-022), natively: the content is the
 * tenant's own. Calls the view makes (form submit, plan confirmation, row actions) go through
 * the playground with the same simulated subject, so the full pipeline and policy apply.
 */
export function ToolUiPreview({ result, args, subject, tokens }: { result: unknown; args: Record<string, unknown>; subject: PreviewSubject; tokens?: ThemeTokens }) {
  const t = useT();
  const toast = useToast();
  const { resolved } = useTheme();
  const host = useMemo<ViewHost>(
    () => ({
      async callTool(name, a, meta) {
        const r = await api<PlaygroundResult>('/playground/call', {
          method: 'POST',
          body: { tool: name, arguments: a, subject, ui: true, ...(meta ? { meta } : {}) },
        });
        return r.result as ToolResultLike;
      },
      sendMessage(text) {
        toast('ok', t('views.messageSent', { text }));
      },
    }),
    [subject, toast, t],
  );
  const r = result as ToolResultLike;
  if (!payloadOf(r)) return <p className="muted">{t('views.noPayload')}</p>;
  return (
    <ThemeScope mode={resolved} tokens={tokens}>
      <ToolView result={r} args={args} host={host} locale={getLocale()} />
    </ThemeScope>
  );
}
