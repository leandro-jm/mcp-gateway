const env = process.env;

export function required(name: string): string {
  const v = env[name]?.trim();
  if (!v) throw new Error(`${name} is required (see apps/bench/.env.example)`);
  return v;
}

export const optional = (name: string): string | undefined => env[name]?.trim() || undefined;

export function numberEnv(name: string, fallback: number): number {
  const v = optional(name);
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${name} must be a non-negative number`);
  return n;
}

/** `model:usd,model:usd` → map. */
export function modelCaps(name: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const pair of (optional(name) ?? '').split(',').filter(Boolean)) {
    const [model, usd] = pair.split(':');
    const n = Number(usd);
    if (!model || !Number.isFinite(n)) throw new Error(`${name}: invalid entry "${pair}"`);
    out[model.trim()] = n;
  }
  return out;
}

export const out = (line = '') => process.stdout.write(`${line}\n`);
