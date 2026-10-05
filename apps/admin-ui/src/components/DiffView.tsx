import { diffLines } from 'diff';

/** Line diff between two JSON values (tool versions, raw × final in the playground). */
export function DiffView({ before, after, maxHeight = 520 }: { before: unknown; after: unknown; maxHeight?: number }) {
  const a = typeof before === 'string' ? before : JSON.stringify(before, null, 2) ?? '';
  const b = typeof after === 'string' ? after : JSON.stringify(after, null, 2) ?? '';
  const parts = diffLines(a, b);
  return (
    <pre className="json" style={{ maxHeight }} data-testid="diff">
      {parts.map((p, i) => (
        <span key={i} className={`diff-line ${p.added ? 'diff-add' : p.removed ? 'diff-del' : ''}`}>
          {p.value
            .replace(/\n$/, '')
            .split('\n')
            .map((l) => `${p.added ? '+ ' : p.removed ? '- ' : '  '}${l}`)
            .join('\n')}
          {'\n'}
        </span>
      ))}
    </pre>
  );
}
