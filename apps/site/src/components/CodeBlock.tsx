import { CopyButton } from './CopyButton';

/** Splits a shell line into command and trailing `# comment` so comments render dimmed. */
function renderLine(line: string, key: number) {
  const hash = line.search(/(^|\s)#\s/);
  if (hash < 0) return <span key={key}>{line}</span>;
  return (
    <span key={key}>
      {line.slice(0, hash)}
      <span className="tok-comment">{line.slice(hash)}</span>
    </span>
  );
}

/** Shell snippet with a copy button. Comments are copied too: they are valid shell. */
export function CodeBlock({ code, lang = 'bash' }: { code: string; lang?: string }) {
  const lines = code.split('\n');
  return (
    <div className="codeblock">
      <div className="codeblock-head">
        <span className="mono-label">{lang}</span>
        <CopyButton text={code} />
      </div>
      <pre>
        <code>
          {lines.map((l, i) => (
            <span className="code-line" key={i}>
              {renderLine(l, i)}
              {'\n'}
            </span>
          ))}
        </code>
      </pre>
    </div>
  );
}
