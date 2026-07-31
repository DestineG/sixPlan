import { describe, expect, it } from 'vitest';
import { isDag, wouldCreateCycle } from './graph.js';

describe('DAG validation', () => {
  const edges = [{ sourceNodeId: 'a', targetNodeId: 'b' }, { sourceNodeId: 'b', targetNodeId: 'c' }];
  it('detects an edge that closes a cycle', () => expect(wouldCreateCycle(edges, 'c', 'a')).toBe(true));
  it('accepts a forward branch', () => expect(wouldCreateCycle(edges, 'a', 'c')).toBe(false));
  it('rejects self edges', () => expect(wouldCreateCycle([], 'a', 'a')).toBe(true));
  it('validates a complete graph', () => {
    expect(isDag(['a', 'b', 'c'], edges)).toBe(true);
    expect(isDag(['a', 'b', 'c'], [...edges, { sourceNodeId: 'c', targetNodeId: 'a' }])).toBe(false);
  });
});
