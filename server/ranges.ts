import { AppError } from "./errors.js";

export interface ByteRange {
  offset: number;
  count: number;
}

export function parseRange(header: string | undefined, size: number): ByteRange | undefined {
  if (!header) return undefined;
  const fail = (): never => { throw new AppError(416, "INVALID_RANGE", "Intervallo di byte non valido."); };
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || size <= 0) return fail();
  const [, from, to] = match;
  if (!from && !to) return fail();
  if (!from) {
    const suffix = Number(to);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return fail();
    const count = Math.min(size, suffix);
    return { offset: size - count, count };
  }
  const offset = Number(from);
  const end = to ? Number(to) : size - 1;
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(end) || offset >= size || end < offset) return fail();
  return { offset, count: Math.min(size - 1, end) - offset + 1 };
}
