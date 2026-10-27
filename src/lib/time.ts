const MONTHS = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const DAY = 86_400_000;

type DateLike = string | number | Date;
const toDate = (v: DateLike) => (v instanceof Date ? v : new Date(v));
const pad = (n: number) => String(n).padStart(2, '0');

export const hhmm = (v: DateLike) => {
  const d = toDate(v);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/** "16 out" */
export const dayMonth = (v: DateLike) => {
  const d = toDate(v);
  return `${pad(d.getDate())} ${MONTHS[d.getMonth()]}`;
};

/** "16/10" */
export const ddmm = (v: DateLike) => {
  const d = toDate(v);
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}`;
};

/** "16 out, 14:20" */
export const dayMonthTime = (v: DateLike) => `${dayMonth(v)}, ${hhmm(v)}`;

export function startOfDay(v: DateLike) {
  const d = new Date(toDate(v));
  d.setHours(0, 0, 0, 0);
  return d;
}

export function calendarDaysBetween(a: DateLike, b: DateLike) {
  return Math.round((startOfDay(b).getTime() - startOfDay(a).getTime()) / DAY);
}

const isWeekday = (d: Date) => d.getDay() !== 0 && d.getDay() !== 6;

export function businessDaysBetween(a: DateLike, b: DateLike) {
  const cur = startOfDay(a);
  const end = startOfDay(b);
  let n = 0;
  while (cur < end) {
    cur.setDate(cur.getDate() + 1);
    if (isWeekday(cur)) n++;
  }
  return n;
}

export function subBusinessDays(from: DateLike, n: number) {
  const d = new Date(toDate(from));
  let left = n;
  while (left > 0) {
    d.setDate(d.getDate() - 1);
    if (isWeekday(d)) left--;
  }
  return d;
}

export const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/** "hoje", "ontem", "há 5 dias" */
export function relDays(n: number) {
  if (n <= 0) return 'hoje';
  if (n === 1) return 'ontem';
  return `há ${n} dias`;
}

/** Horário curto da lista de conversas. */
export function listTime(v: DateLike, now: number) {
  const d = toDate(v);
  if (now - d.getTime() < 60_000) return 'agora';
  const days = calendarDaysBetween(d, now);
  if (days === 0) return hhmm(d);
  if (days === 1) return 'ontem';
  return ddmm(d);
}

/** Separador de dia no histórico. */
export function dayLabel(v: DateLike, now: number) {
  const days = calendarDaysBetween(v, now);
  if (days === 0) return 'Hoje';
  if (days === 1) return 'Ontem';
  return dayMonth(v);
}

/** "14h" ou "14h30" */
export function hourLabel(d: Date) {
  return d.getMinutes() === 0 ? `${d.getHours()}h` : `${d.getHours()}h${pad(d.getMinutes())}`;
}
