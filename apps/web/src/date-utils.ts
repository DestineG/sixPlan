export type DateIncrementUnit = 'day' | 'week' | 'month';

function parseDateOnly(value: string): { year: number; month: number; day: number } {
  const [year, month, day] = value.split('-').map(Number);
  if (!year || !month || !day) throw new Error('无效日期');
  return { year, month, day };
}

function formatDateOnly(year: number, month: number, day: number): string {
  return `${year.toString().padStart(4, '0')}-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`;
}

export function localToday(now = new Date()): string {
  return formatDateOnly(now.getFullYear(), now.getMonth() + 1, now.getDate());
}

export function addToDateOnly(value: string, amount: number, unit: DateIncrementUnit): string {
  const { year, month, day } = parseDateOnly(value);
  if (unit === 'day' || unit === 'week') {
    const date = new Date(Date.UTC(year, month - 1, day));
    date.setUTCDate(date.getUTCDate() + amount * (unit === 'week' ? 7 : 1));
    return formatDateOnly(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
  }

  const targetMonthIndex = month - 1 + amount;
  const targetYear = year + Math.floor(targetMonthIndex / 12);
  const targetMonth = ((targetMonthIndex % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  return formatDateOnly(targetYear, targetMonth + 1, Math.min(day, lastDay));
}
