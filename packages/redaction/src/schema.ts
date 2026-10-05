import { detectFieldName, FIELD_DETECTORS, type FieldDetector } from './detectors';

type Schema = Record<string, unknown>;
const isObj = (v: unknown): v is Schema => typeof v === 'object' && v !== null && !Array.isArray(v);

function widenToString(s: Schema): Schema {
  const out: Schema = { ...s };
  delete out.format;
  delete out.enum;
  delete out.pattern;
  delete out.minimum;
  delete out.maximum;
  delete out.properties;
  delete out.items;
  delete out.required;
  const types = new Set<string>(Array.isArray(s.type) ? (s.type as string[]) : typeof s.type === 'string' ? [s.type] : []);
  types.add('string');
  types.add('null');
  out.type = [...types];
  if (types.has('object')) out.additionalProperties = true;
  return out;
}

/**
 * Adjusts the advertised output schema to what the gateway actually returns after
 * redaction and projection: no field is required (they may be removed), objects
 * accept extra properties (truncation metadata) and PII fields detected by name
 * may become a masked string or `null`.
 */
export function relaxOutputSchema(schema: Schema, detectors: FieldDetector[] = FIELD_DETECTORS): Schema {
  const out: Schema = { ...schema };
  delete out.required;
  // Objects accept extra properties (projection `_meta`, artifact summary, composite `_errors`).
  delete out.additionalProperties;
  if (isObj(schema.properties)) {
    const props: Schema = {};
    for (const [k, v] of Object.entries(schema.properties)) {
      if (!isObj(v)) continue;
      props[k] = detectFieldName(k, detectors) ? widenToString(v) : relaxOutputSchema(v, detectors);
    }
    out.properties = props;
  }
  if (isObj(schema.items)) {
    out.items = relaxOutputSchema(schema.items, detectors);
    // items may become null (PII dropped inside an array)
  }
  for (const k of ['oneOf', 'anyOf', 'allOf'] as const) {
    if (Array.isArray(schema[k])) out[k] = (schema[k] as unknown[]).map((b) => (isObj(b) ? relaxOutputSchema(b, detectors) : b));
  }
  return out;
}
