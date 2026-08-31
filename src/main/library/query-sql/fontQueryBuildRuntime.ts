import type { FontQueryRequest } from '@shared/types';
import { fontListSelectColumns } from '../fontSqliteMapper';
import { addActiveFilterClauses, addKeywordClause, addPageFilterClauses, addTimeRangeClause, timeRangeStartForSql } from './fontQueryClausesRuntime';
import { fontQueryOrderBy } from './fontQueryOrderRuntime';
import { normalizeQueryLimit, type FontQuerySqlParts } from './fontQuerySqlTypes';

function createBaseFontQuerySqlParts(): FontQuerySqlParts {
  return {
    clauses: ["fonts.deleted_at IS NULL"],
    params: [],
    joins: [
      "LEFT JOIN font_search ON font_search.font_id = fonts.id",
      "LEFT JOIN install_status ON install_status.font_id = fonts.id",
    ],
    usedLike: false,
  };
}

function applyCommonFontQueryClauses(
  parts: FontQuerySqlParts,
  request: FontQueryRequest,
): void {
  addKeywordClause(parts, String(request.keyword || ""));
  addTimeRangeClause(parts, request.timeSortMode);
  if ((request.sidebarPage || "library") === "library") addActiveFilterClauses(parts, request);
  addPageFilterClauses(parts, request);
}

export { timeRangeStartForSql };

export function buildFontQuerySql(request: FontQueryRequest): {
  sql: string;
  params: unknown[];
  usedLike: boolean;
} {
  const parts = createBaseFontQuerySqlParts();
  applyCommonFontQueryClauses(parts, request);

  const limit = normalizeQueryLimit(request);
  const where = parts.clauses.length
    ? `WHERE ${parts.clauses.join(" AND ")}`
    : "";
  const orderBy = fontQueryOrderBy(request);
  return {
    sql: `
      SELECT fonts.id AS id
      FROM fonts
      ${parts.joins.join(" ")}
      ${where}
      ORDER BY ${orderBy}
      LIMIT ?
    `,
    params: [...parts.params, limit + 1],
    usedLike: parts.usedLike,
  };
}

export function buildFontQueryPageSql(request: FontQueryRequest): {
  sql: string;
  countSql: string;
  params: unknown[];
  countParams: unknown[];
  usedLike: boolean;
  limit: number;
  offset: number;
} {
  const parts = createBaseFontQuerySqlParts();
  applyCommonFontQueryClauses(parts, request);

  const limit = Math.max(1, Math.min(500, Number(request.limit || 200) || 200));
  const offset = Math.max(0, Number(request.offset || 0) || 0);
  const where = parts.clauses.length
    ? `WHERE ${parts.clauses.join(" AND ")}`
    : "";
  const orderBy = fontQueryOrderBy(request);
  return {
    sql: `
      SELECT ${fontListSelectColumns("fonts")}
      FROM fonts
      LEFT JOIN font_details ON font_details.font_id = fonts.id
      ${parts.joins.join(" ")}
      ${where}
      ORDER BY ${orderBy}
      LIMIT ? OFFSET ?
    `,
    countSql: `
      SELECT COUNT(*) AS count
      FROM fonts
      ${parts.joins.join(" ")}
      ${where}
    `,
    params: [...parts.params, limit, offset],
    countParams: [...parts.params],
    usedLike: parts.usedLike,
    limit,
    offset,
  };
}
