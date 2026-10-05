import { json } from '@codemirror/lang-json';
import { yaml } from '@codemirror/lang-yaml';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';
import { EditorView } from '@codemirror/view';
import CodeMirror from '@uiw/react-codemirror';
import { useTheme } from '../theme/theme';

const themeSpec = {
    '&': { backgroundColor: 'var(--surface)', color: 'var(--text)', fontSize: '13px' },
    '.cm-content': { fontFamily: 'var(--font-mono)', caretColor: 'var(--accent)' },
    '.cm-gutters': { backgroundColor: 'var(--bg)', color: 'var(--text-3)', border: 'none', borderRight: '1px solid var(--border)' },
    '.cm-activeLine': { backgroundColor: 'var(--active-line)' },
    '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--text-2)' },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': { backgroundColor: 'var(--selection) !important' },
    '&.cm-focused': { outline: 'none' },
};
// Colors come from the theme tokens; the `dark` flag only adjusts CodeMirror's base styles.
const darkTheme = EditorView.theme(themeSpec, { dark: true });
const lightTheme = EditorView.theme(themeSpec, { dark: false });

/** Console-themed highlighting: strings in orange (accent), light keys, numbers/literals in gray. */
const highlight = syntaxHighlighting(
  HighlightStyle.define([
    { tag: [t.string, t.special(t.string)], color: 'var(--accent)' },
    { tag: [t.propertyName, t.definition(t.propertyName)], color: 'var(--code-key)' },
    { tag: [t.number, t.bool, t.null, t.atom], color: 'var(--code-literal)' },
    { tag: [t.keyword, t.operator], color: 'var(--text-2)' },
    { tag: [t.comment, t.lineComment], color: 'var(--text-3)', fontStyle: 'italic' },
    { tag: [t.punctuation, t.brace, t.squareBracket, t.separator], color: 'var(--text-2)' },
  ]),
);

export function Editor({ value, onChange, language = 'json', height = '280px', readOnly = false, label }: { value: string; onChange?(v: string): void; language?: 'json' | 'yaml'; height?: string; readOnly?: boolean; label?: string }) {
  const { resolved } = useTheme();
  return (
    <div className="cm-theme-gw" aria-label={label}>
      <CodeMirror
        value={value}
        height={height}
        theme={resolved === 'light' ? lightTheme : darkTheme}
        extensions={[language === 'yaml' ? yaml() : json(), EditorView.lineWrapping, highlight]}
        onChange={onChange}
        readOnly={readOnly}
        basicSetup={{ foldGutter: false, highlightActiveLineGutter: true }}
      />
    </div>
  );
}
