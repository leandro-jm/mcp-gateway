import { describe, expect, it } from 'vitest';
import { diffTools, summarizeDiff, type DiffableTool } from '../src';

const base: DiffableTool = {
  name: 'rh_x_get',
  description: 'd',
  annotations: { readOnlyHint: true },
  inputSchema: {
    type: 'object',
    properties: { id: { type: 'string' }, tipo: { type: 'string', enum: ['a', 'b'] }, opt: { type: 'integer' } },
    required: ['id'],
  },
  outputSchema: { type: 'object', properties: { id: { type: 'string' }, nome: { type: 'string' } }, required: ['id'] },
};

const withInput = (patch: Record<string, unknown>): DiffableTool => ({ ...base, inputSchema: { ...base.inputSchema, ...patch } });

describe('tool diff', () => {
  it('no changes', () => {
    expect(diffTools(base, structuredClone(base))).toEqual({ breaking: false, changes: [] });
    expect(summarizeDiff(diffTools(base, structuredClone(base)))).toBe('no changes');
  });

  it('new required input field is breaking', () => {
    const d = diffTools(base, withInput({ required: ['id', 'opt'] }));
    expect(d.breaking).toBe(true);
    expect(d.changes).toEqual([{ kind: 'required_added', path: 'input.opt', breaking: true }]);
  });

  it('field removed from input is breaking; new optional field is not', () => {
    const removed = diffTools(base, withInput({ properties: { id: { type: 'string' }, tipo: { type: 'string', enum: ['a', 'b'] } } }));
    expect(removed.breaking).toBe(true);
    const added = diffTools(base, withInput({ properties: { ...(base.inputSchema.properties as object), novo: { type: 'string' } } }));
    expect(added).toEqual({ breaking: false, changes: [{ kind: 'field_added', path: 'input.novo', breaking: false }] });
  });

  it('changed type is breaking (input and output)', () => {
    const d = diffTools(base, withInput({ properties: { ...(base.inputSchema.properties as object), opt: { type: 'string' } } }));
    expect(d.changes[0]).toMatchObject({ kind: 'type_changed', path: 'input.opt', from: 'integer', to: 'string', breaking: true });
    const out = diffTools(base, { ...base, outputSchema: { type: 'object', properties: { id: { type: 'integer' }, nome: { type: 'string' } } } });
    expect(out.breaking).toBe(true);
  });

  it('field removed from output is breaking; description is compatible', () => {
    const d = diffTools(base, { ...base, description: 'nova', outputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } });
    expect(d.breaking).toBe(true);
    expect(summarizeDiff(d)).toBe('field_removed×1, description_changed×1');
    expect(diffTools(base, { ...base, description: 'nova' }).breaking).toBe(false);
  });

  it('narrowed input enum is breaking; widened is not', () => {
    const narrowed = diffTools(base, withInput({ properties: { ...(base.inputSchema.properties as object), tipo: { type: 'string', enum: ['a'] } } }));
    expect(narrowed.breaking).toBe(true);
    const widened = diffTools(base, withInput({ properties: { ...(base.inputSchema.properties as object), tipo: { type: 'string', enum: ['a', 'b', 'c'] } } }));
    expect(widened.breaking).toBe(false);
  });

  it('nullable becomes a type union without order false positives', () => {
    const a = { ...base, outputSchema: { type: 'object', properties: { x: { type: ['string', 'null'] } } } };
    const b = { ...base, outputSchema: { type: 'object', properties: { x: { type: ['null', 'string'] } } } };
    expect(diffTools(a, b).breaking).toBe(false);
  });
});
