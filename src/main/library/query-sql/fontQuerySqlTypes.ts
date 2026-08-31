import type { FontQueryRequest } from '@shared/types';

export const FONT_SEARCH_RESULT_LIMIT_DEFAULT = 200000;

export type FontQuerySqlParts = {
  clauses: string[];
  params: unknown[];
  joins: string[];
  usedLike: boolean;
};

export function escapeSqlLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

export function sanitizeStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? Array.from(
        new Set(value.map((item) => String(item || "").trim()).filter(Boolean)),
      )
    : [];
}

export function normalizeQueryLimit(
  request: Pick<FontQueryRequest, 'limit'>,
  fallback = FONT_SEARCH_RESULT_LIMIT_DEFAULT,
  max = 500000,
): number {
  return Math.max(
    1,
    Math.min(max, Number(request.limit || fallback) || fallback),
  );
}
