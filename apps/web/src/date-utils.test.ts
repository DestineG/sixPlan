import { describe, expect, it } from 'vitest';
import { addToDateOnly, deriveDateManagedNodeStatus, isNodeOverdue, localToday } from './date-utils';

describe('date shortcuts', () => {
  it('formats today using the local calendar date', () => {
    expect(localToday(new Date(2026, 7, 1, 23, 30))).toBe('2026-08-01');
  });

  it('adds days and weeks to a date-only value', () => {
    expect(addToDateOnly('2026-08-01', 1, 'day')).toBe('2026-08-02');
    expect(addToDateOnly('2026-08-01', 1, 'week')).toBe('2026-08-08');
  });

  it('adds natural months and clamps to the target month end', () => {
    expect(addToDateOnly('2025-01-31', 1, 'month')).toBe('2025-02-28');
    expect(addToDateOnly('2024-01-31', 1, 'month')).toBe('2024-02-29');
    expect(addToDateOnly('2026-11-30', 3, 'month')).toBe('2027-02-28');
  });

  it('derives only date-managed node statuses from the start date', () => {
    expect(deriveDateManagedNodeStatus('in_progress', null, '2026-08-01')).toBe('not_started');
    expect(deriveDateManagedNodeStatus('in_progress', '2026-08-02', '2026-08-01')).toBe('not_started');
    expect(deriveDateManagedNodeStatus('not_started', '2026-08-01', '2026-08-01')).toBe('in_progress');
    expect(deriveDateManagedNodeStatus('not_started', '2026-07-31', '2026-08-01')).toBe('in_progress');
  });

  it('preserves manual statuses and reports overdue in-progress nodes', () => {
    expect(deriveDateManagedNodeStatus('completed', '2026-08-02', '2026-08-01')).toBe('completed');
    expect(deriveDateManagedNodeStatus('paused', '2026-07-01', '2026-08-01')).toBe('paused');
    expect(deriveDateManagedNodeStatus('abandoned', null, '2026-08-01')).toBe('abandoned');
    expect(isNodeOverdue('in_progress', '2026-07-31', '2026-08-01')).toBe(true);
    expect(isNodeOverdue('completed', '2026-07-31', '2026-08-01')).toBe(false);
    expect(isNodeOverdue('in_progress', '2026-08-01', '2026-08-01')).toBe(false);
  });
});
