import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * PLAN §6 rule: every repository receives an explicit `tenantId`.
 * Every public method of the classes in `src/repositories` must take `tenantId` as its first parameter.
 * Exception: classes documented with `@cross-tenant`.
 */
const dir = fileURLToPath(new URL('../src/repositories', import.meta.url));

function violations(): string[] {
  const out: string[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
    const src = ts.createSourceFile(file, readFileSync(`${dir}/${file}`, 'utf8'), ts.ScriptTarget.Latest, true);
    src.forEachChild((node) => {
      if (!ts.isClassDeclaration(node) || !node.name) return;
      const jsDoc = ts.getJSDocCommentsAndTags(node).map((d) => d.getText()).join('\n');
      if (jsDoc.includes('@cross-tenant')) return;
      for (const member of node.members) {
        if (!ts.isMethodDeclaration(member) || !member.name) continue;
        const mods = ts.getModifiers(member) ?? [];
        if (mods.some((m) => m.kind === ts.SyntaxKind.PrivateKeyword || m.kind === ts.SyntaxKind.ProtectedKeyword)) continue;
        if (ts.isPrivateIdentifier(member.name)) continue;
        const first = member.parameters[0];
        if (!first || first.name.getText() !== 'tenantId') {
          out.push(`${file}: ${node.name.text}.${member.name.getText()} does not take tenantId as its 1st parameter`);
        }
      }
    });
  }
  return out;
}

describe('architecture: multi-tenant isolation', () => {
  it('every public repository method receives an explicit tenantId', () => {
    expect(violations()).toEqual([]);
  });
});
