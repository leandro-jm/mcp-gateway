import { describe, expect, it } from 'vitest';
import { abandonment, analyzeSessions, detectLoops, detectThrash, mineSequences, searchMisses, sessionize, transitions, type TrajectoryEvent } from './index';

let n = 0;
const T0 = new Date('2026-10-04T10:00:00Z').getTime();

function ev(sessionKey: string, secs: number, toolName: string, over: Partial<TrajectoryEvent> = {}): TrajectoryEvent {
  return {
    ts: new Date(T0 + secs * 1000),
    callId: `c${++n}`,
    sessionKey,
    subject: over.subject ?? `user-${sessionKey}`,
    kind: 'tool',
    toolName,
    decision: 'allow',
    argsHash: `h-${toolName}`,
    ...over,
  };
}

describe('agent analytics (F15.20)', () => {
  it('sessionize splits a key on idle gaps', () => {
    const s = sessionize([ev('a', 0, 'x'), ev('a', 60, 'y'), ev('a', 3 * 3600, 'z'), ev('b', 0, 'x')]);
    expect(s.map((x) => [x.id, x.events.length])).toEqual([
      ['a#0', 2],
      ['a#1', 1],
      ['b#0', 1],
    ]);
  });

  it('detects loops: same tool and arguments repeated in a window', () => {
    const [s] = sessionize([ev('a', 0, 'get'), ev('a', 10, 'get'), ev('a', 20, 'get'), ev('a', 30, 'get', { argsHash: 'other' }), ev('a', 40, 'list')]);
    const f = detectLoops(s!);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ type: 'loop', tool: 'get', count: 3 });
    expect(detectLoops(sessionize([ev('b', 0, 'get'), ev('b', 900, 'get'), ev('b', 1800, 'get')])[0]!)).toEqual([]);
  });

  it('detects thrash: alternating failing tools without progress', () => {
    const calls = ['a', 'b', 'a', 'b', 'a', 'b'].map((t, i) => ev('t', i * 5, t, { decision: 'error' }));
    const f = detectThrash(sessionize(calls)[0]!);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ type: 'thrash', tool: 'a', related: ['b'] });
    const progress = ['a', 'b', 'a', 'b', 'a', 'b'].map((t, i) => ev('p', i * 5, t));
    expect(detectThrash(sessionize(progress)[0]!)).toEqual([]);
  });

  it('flags search misses: tool not in the results, validation error, re-search', () => {
    const search = (secs: number, results: string[]) => ev('s', secs, 'search_tools', { kind: 'meta', meta: { results } });
    const s = sessionize([
      search(0, ['rh_a', 'rh_b']),
      ev('s', 5, 'rh_c'),
      search(100, ['rh_a']),
      ev('s', 105, 'rh_a', { decision: 'error', errorStage: 'validation' }),
      search(200, ['rh_b']),
      search(210, ['rh_b']),
      ev('s', 220, 'rh_b'),
    ])[0]!;
    expect(searchMisses(s).map((f) => f.detail)).toEqual(['not_in_results', 'validation_error', 're_search']);
  });

  it('abandonment: last call of a tool failed', () => {
    const s = sessionize([ev('x', 0, 'a', { decision: 'error', errorCode: 'UPSTREAM_ERROR' }), ev('x', 5, 'b', { decision: 'error' }), ev('x', 10, 'b')])[0]!;
    expect(abandonment(s)).toEqual([expect.objectContaining({ type: 'abandoned', tool: 'a', detail: 'UPSTREAM_ERROR' })]);
  });

  it('mines frequent sequences across sessions and subjects, keeping the longest with equal support', () => {
    const sessions = sessionize(
      ['s1', 's2', 's3', 's4'].flatMap((k, i) => [ev(k, 0, 'colab_get'), ev(k, 5, 'escalas_list'), ev(k, 10, 'marcacoes_list'), ...(i === 0 ? [ev(k, 15, 'other')] : [])]),
    );
    const seqs = mineSequences(sessions);
    expect(seqs[0]).toMatchObject({ sequence: ['colab_get', 'escalas_list', 'marcacoes_list'], sessions: 4, subjects: 4, share: 1 });
    expect(seqs.some((s) => s.sequence.join() === 'colab_get,escalas_list')).toBe(false);
    expect(mineSequences(sessions, { minSubjects: 5 })).toEqual([]);
  });

  it('co-usage transitions and the full analysis', () => {
    const sessions = sessionize([ev('a', 0, 'x'), ev('a', 1, 'y'), ev('b', 0, 'x'), ev('b', 1, 'y'), ev('b', 2, 'z')]);
    expect(transitions(sessions)).toEqual([
      { from: 'x', to: 'y', count: 2 },
      { from: 'y', to: 'z', count: 1 },
    ]);
    expect(analyzeSessions(sessions)).toEqual([]);
  });
});
