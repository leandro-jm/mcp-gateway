import { msg, translate, type ServerMessage } from '@mcp-gateway/i18n/server';
import { z } from 'zod';

/**
 * Envelope returned by the model (ADR-015). The definition travels as YAML text: the composite
 * schema has free-form records (`args`, `input`) that strict JSON Schema modes do not accept.
 */
export const proposalSchema = z.object({
  definition_yaml: z.string().max(50_000),
  explanation: z.string().max(4000),
  assumptions: z.array(z.string().max(1000)).max(20),
  unsupported: z.string().max(1000).nullable(),
});

export type Proposal = z.output<typeof proposalSchema>;

/** Same contract as `proposalSchema`, in the strict subset accepted by the providers' structured outputs. */
export const PROPOSAL_JSON_SCHEMA = {
  type: 'object',
  properties: {
    definition_yaml: { type: 'string', description: 'The composite YAML document' },
    explanation: { type: 'string', description: 'How the composite works, in 2 to 4 sentences' },
    assumptions: { type: 'array', items: { type: 'string' }, description: 'Assumptions made' },
    unsupported: { type: ['string', 'null'], description: 'Why the catalog cannot meet the request, or null' },
  },
  required: ['definition_yaml', 'explanation', 'assumptions', 'unsupported'],
  additionalProperties: false,
} as const;

export class ProposalError extends Error {
  readonly msg: ServerMessage;

  constructor(error: string) {
    const m = msg('composer.invalidProposal', { error });
    super(translate(m));
    this.name = 'ProposalError';
    this.msg = m;
  }
}

/** Providers in plain JSON mode sometimes wrap the object in a Markdown fence. */
function stripFence(text: string): string {
  const m = /^\s*```(?:json)?\s*\n([\s\S]*?)\n\s*```\s*$/.exec(text);
  return m ? m[1]! : text;
}

/** Validates the model output (an object, or JSON text) against the envelope. Throws `ProposalError`. */
export function parseProposal(output: unknown): Proposal {
  let data = output;
  if (typeof output === 'string') {
    try {
      data = JSON.parse(stripFence(output));
    } catch (err) {
      throw new ProposalError((err as Error).message);
    }
  }
  const r = proposalSchema.safeParse(data);
  if (!r.success) throw new ProposalError(r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; '));
  return r.data;
}
