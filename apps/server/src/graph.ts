export interface DirectedEdge {
  sourceNodeId: string;
  targetNodeId: string;
}

export function wouldCreateCycle(edges: DirectedEdge[], sourceNodeId: string, targetNodeId: string): boolean {
  if (sourceNodeId === targetNodeId) return true;
  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    const targets = adjacency.get(edge.sourceNodeId) ?? [];
    targets.push(edge.targetNodeId);
    adjacency.set(edge.sourceNodeId, targets);
  }
  const stack = [targetNodeId];
  const visited = new Set<string>();
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current === sourceNodeId) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    stack.push(...(adjacency.get(current) ?? []));
  }
  return false;
}

export function isDag(nodeIds: string[], edges: DirectedEdge[]): boolean {
  const indegree = new Map(nodeIds.map((id) => [id, 0]));
  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    if (!indegree.has(edge.sourceNodeId) || !indegree.has(edge.targetNodeId)) return false;
    indegree.set(edge.targetNodeId, indegree.get(edge.targetNodeId)! + 1);
    adjacency.set(edge.sourceNodeId, [...(adjacency.get(edge.sourceNodeId) ?? []), edge.targetNodeId]);
  }
  const queue = [...indegree.entries()].filter(([, degree]) => degree === 0).map(([id]) => id);
  let visited = 0;
  while (queue.length > 0) {
    const id = queue.shift()!;
    visited += 1;
    for (const target of adjacency.get(id) ?? []) {
      const degree = indegree.get(target)! - 1;
      indegree.set(target, degree);
      if (degree === 0) queue.push(target);
    }
  }
  return visited === nodeIds.length;
}
