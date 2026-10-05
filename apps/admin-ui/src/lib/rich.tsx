import { Fragment, type ReactNode } from 'react';
import type { Params } from '@mcp-gateway/i18n';
import type { T, UiMessageKey } from '../i18n';

const MARK = '\u0000';

/**
 * Translates a message whose placeholders are React nodes (`<code>`, `<b>`, links…).
 * Each node placeholder is rendered as a sentinel and then swapped for the node, so the
 * translation keeps full control of the word order.
 *
 * `rich(t, 'toolDrawer.allowAgentFields', { fields: <code>_fields</code> })`
 */
export function rich(t: T, key: UiMessageKey, nodes: Record<string, ReactNode>, params: Params = {}): ReactNode {
  const marks = Object.fromEntries(Object.keys(nodes).map((name) => [name, `${MARK}${name}${MARK}`]));
  const parts = t(key, { ...params, ...marks }).split(MARK);
  // odd indexes are placeholder names
  return parts.map((part, i) => <Fragment key={i}>{i % 2 === 1 ? (nodes[part] ?? part) : part}</Fragment>);
}
