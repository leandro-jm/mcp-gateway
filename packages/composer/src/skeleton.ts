import { stringify } from 'yaml';

/**
 * Composite draft from a frequent call sequence (F15.20): one step per tool, wiring each step's
 * required inputs to an earlier step's output when a field name matches, and leaving the rest as
 * composite inputs. The owner reviews it in the Composer (human in the loop, ADR-015).
 */
export interface SkeletonTool {
  name: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown> | null;
}

type Props = Record<string, { type?: unknown; description?: unknown }>;

const propsOf = (schema: Record<string, unknown> | null | undefined): Props => {
  if (!schema) return {};
  const p = schema.properties as Props | undefined;
  if (p) return p;
  // list responses wrap the records: look one level inside the first array property
  for (const v of Object.values((schema.properties ?? {}) as Props)) {
    const items = (v as { items?: { properties?: Props } }).items;
    if (items?.properties) return items.properties;
  }
  return {};
};

const requiredOf = (schema: Record<string, unknown>): string[] => (Array.isArray(schema.required) ? (schema.required as string[]) : []);

/** `colaborador` ↔ `colaborador_id` ↔ `id` of the previous step. */
function matchField(input: string, output: string[]): string | undefined {
  if (output.includes(input)) return input;
  const base = input.replace(/_id$/, '');
  if (output.includes(`${base}_id`)) return `${base}_id`;
  if (output.includes('id') && (input.endsWith('_id') || input === base)) return 'id';
  return undefined;
}

const stepIdOf = (tool: string, used: Set<string>) => {
  const base = tool.replace(/^[a-z0-9]+_/, '').replace(/[^a-z0-9_]/g, '_').slice(0, 40) || 'step';
  let id = /^[a-z]/.test(base) ? base : `s_${base}`;
  for (let i = 2; used.has(id); i++) id = `${base}_${i}`;
  used.add(id);
  return id;
};

export function skeletonFromSequence(tools: SkeletonTool[], opts: { name: string; description: string }): string {
  const input: Record<string, unknown> = {};
  const required: string[] = [];
  const used = new Set<string>();
  const steps: Array<{ id: string; tool: string; args: Record<string, string> }> = [];
  for (const tool of tools) {
    const id = stepIdOf(tool.name, used);
    const args: Record<string, string> = {};
    const toolProps = propsOf(tool.inputSchema);
    for (const prop of requiredOf(tool.inputSchema)) {
      let wired: string | undefined;
      for (let i = steps.length - 1; i >= 0 && !wired; i--) {
        const prev = tools[i]!;
        const field = matchField(prop, Object.keys(propsOf(prev.outputSchema)));
        if (field) wired = `$steps.${steps[i]!.id}.${field}`;
      }
      if (!wired) {
        if (!(prop in input)) {
          input[prop] = { type: (toolProps[prop]?.type as string | undefined) ?? 'string', ...(toolProps[prop]?.description ? { description: toolProps[prop]!.description } : {}) };
          required.push(prop);
        }
        wired = `$input.${prop}`;
      }
      args[prop] = wired;
    }
    steps.push({ id, tool: tool.name, args });
  }
  const output = `{\n${steps.map((s) => `  "${s.id}": $steps.${s.id}`).join(',\n')}\n}`;
  return stringify({
    name: opts.name,
    description: opts.description,
    input: { type: 'object', ...(required.length ? { required } : {}), properties: input },
    steps,
    output,
    failure_mode: 'partial',
  });
}
