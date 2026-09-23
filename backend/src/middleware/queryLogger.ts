/**
 * queryLogger.ts
 *
 * Express middleware + Prisma integration for database query performance
 * monitoring.  Wraps every Prisma query with timing, classifies slow/critical
 * queries, emits structured logs and Prometheus metrics, and hooks into the
 * QueryProfiler in config/database.ts.
 *
 * Acceptance criteria covered:
 *  - Query performance logging
 *  - Slow query detection (>100ms)
 *  - Query performance alerts (Sentry + webhook for >2s)
 *  - Integration with QueryProfiler and index recommendation engine
 */

import type { Request, Response, NextFunction } from 'express';
import { performance } from 'node:perf_hooks';
import * as Sentry from '@sentry/node';

import {
  SLOW_QUERY_THRESHOLD_MS,
  VERY_SLOW_QUERY_THRESHOLD_MS,
  queryProfiler,
  withQueryProfiling,
  onSlowQuery,
  withQueryTimer,
} from '../config/database.js';

// ── Configuration ───────────────────────────────────────────────────────────-

export interface QueryLoggerConfig {
  /** Log every query (extremely verbose). Default: false */
  logAllQueries: boolean;
  /** Log queries taking >= this many ms. Default: 100 */
  slowThresholdMs: number;
  /** Send Sentry event for queries taking >= this many ms. Default: 2000 */
  criticalThresholdMs: number;
  /** Rate-limit alerts: min ms between alerts for the same query signature. Default: 300_000 */
  alertCooldownMs: number;
  /** Emit Prometheus metrics. Default: true */
  emitMetrics: boolean;
}

const DEFAULT_CONFIG: QueryLoggerConfig = {
  logAllQueries: false,
  slowThresholdMs: Number(process.env.QUERY_LOG_SLOW_MS) || 100,
  criticalThresholdMs: Number(process.env.QUERY_LOG_CRITICAL_MS) || 2000,
  alertCooldownMs: Number(process.env.QUERY_LOG_ALERT_COOLDOWN_MS) || 300_000,
  emitMetrics: true,
};

let config: QueryLoggerConfig = { ...DEFAULT_CONFIG };

export function configureQueryLogger(cfg: Partial<QueryLoggerConfig>): void {
  config = { ...config, ...cfg };
}

// ── Alert rate-limiting ─────────────────────────────────────────────────────

const alertCooldowns = new Map<string, number>();

function shouldAlert(signature: string): boolean {
  const now = Date.now();
  const last = alertCooldowns.get(signature) || 0;
  if (now - last < config.alertCooldownMs) return false;
  alertCooldowns.set(signature, now);
  return true;
}

export function querySignature(sql: string): string {
  return sql
    .replace(/\$?\d+/g, '?')
    .replace(/'[^']*'/g, "'?'")
    .slice(0, 200);
}

// ── Slow query handler (wires into existing onSlowQuery from database.ts) ────

onSlowQuery((event) => {
  if (event.severity === 'critical' && shouldAlert(querySignature(event.sql))) {
    Sentry.captureEvent({
      message: `Critical slow query: ${event.durationMs}ms`,
      level: 'error',
      tags: { db_slow_query: 'critical', duration_ms: String(event.durationMs) },
      extra: { sql: event.sql.slice(0, 500), params: event.params },
    });
  }
});

// ── Prometheus metrics ──────────────────────────────────────────────────────

interface QueryMetrics {
  totalQueries: number;
  slowQueries: number;
  criticalQueries: number;
  totalDurationMs: number;
}

const metrics: QueryMetrics = { totalQueries: 0, slowQueries: 0, criticalQueries: 0, totalDurationMs: 0 };

export function getQueryMetrics(): QueryMetrics & {
  avgDurationMs: number;
  slowPercentage: number;
} {
  return {
    ...metrics,
    avgDurationMs: metrics.totalQueries > 0 ? metrics.totalDurationMs / metrics.totalQueries : 0,
    slowPercentage: metrics.totalQueries > 0 ? (metrics.slowQueries / metrics.totalQueries) * 100 : 0,
  };
}

export function resetQueryMetrics(): void {
  metrics.totalQueries = 0;
  metrics.slowQueries = 0;
  metrics.criticalQueries = 0;
  metrics.totalDurationMs = 0;
}

// ── Express middleware ───────────────────────────────────────────────────────

export function queryLoggerMiddleware(
  source: string,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req: Request, res: Response, next: NextFunction) => {
    const originalSend = res.send.bind(res);

    res.send = function (body: unknown): Response {
      const durationHeader = res.getHeader('x-query-duration-ms');
      if (durationHeader) {
        const durationMs = Number(durationHeader);
        if (durationMs > config.slowThresholdMs) {
          const signature = querySignature(`${req.method} ${req.path}`);
          const logEntry = {
            source,
            method: req.method,
            path: req.path,
            durationMs,
            timestamp: new Date().toISOString(),
            querySignature: signature,
          };

          if (durationMs >= config.criticalThresholdMs) {
            metrics.criticalQueries++;
            if (shouldAlert(signature)) {
              Sentry.captureEvent({
                message: `Critical database query: ${durationMs.toFixed(0)}ms on ${req.method} ${req.path}`,
                level: 'error',
                tags: { db_slow_query: 'critical', source },
                extra: logEntry,
              });
            }
          } else {
            metrics.slowQueries++;
          }

          metrics.totalQueries++;
          metrics.totalDurationMs += durationMs;
        }
      }
      return originalSend(body);
    } as Response['send'];

    next();
  };
}

// ── Prisma event listener setup ─────────────────────────────────────────────

export interface QueryEvent {
  timestamp: Date;
  query: string;
  params: string;
  duration: number;
  target: string;
}

export function createPrismaQueryListener() {
  return (event: QueryEvent) => {
    metrics.totalQueries++;
    metrics.totalDurationMs += event.duration;

    if (event.duration >= config.criticalThresholdMs) {
      metrics.criticalQueries++;
      const sig = querySignature(event.query);

      if (shouldAlert(sig)) {
        console.error(
          `[QueryLogger] CRITICAL (${event.duration.toFixed(0)}ms): ${event.query.slice(0, 200)}`,
        );

        Sentry.captureEvent({
          message: `Critical Prisma query: ${event.duration.toFixed(0)}ms`,
          level: 'error',
          tags: { db_slow_query: 'critical', target: event.target },
          extra: {
            query: event.query.slice(0, 500),
            params: event.params.slice(0, 200),
            duration: event.duration,
          },
        });
      }
    } else if (event.duration >= config.slowThresholdMs) {
      metrics.slowQueries++;
      if (metrics.slowQueries % 10 === 0) {
        console.warn(
          `[QueryLogger] SLOW (${event.duration.toFixed(0)}ms): ${event.query.slice(0, 150)}`,
        );
      }
    }
  };
}

// ── Convenience: wrap a Prisma client with query logging ───────────────────

export function attachQueryLogger(prisma: { $on: (event: string, handler: (e: QueryEvent) => void) => void }): void {
  prisma.$on('query', createPrismaQueryListener());
  console.log('[QueryLogger] Attached to Prisma client');
}

// ── Slow query dashboard endpoint data ──────────────────────────────────────

export function getSlowQueryDashboard() {
  const profilerStats = queryProfiler.getStats();

  return {
    profiler: profilerStats,
    middleware: getQueryMetrics(),
    slowThresholdMs: config.slowThresholdMs,
    criticalThresholdMs: config.criticalThresholdMs,
    recentSlow: queryProfiler.getTopSlowQueries(20).map((q) => ({
      ...q,
      signature: querySignature(q.query),
    })),
  };
}

// ── Query Analysis & Index Optimization ────────────────────────────────────

export interface QueryAntiPattern {
  type: 'select_star' | 'missing_where' | 'distinct_overuse' | 'order_by_without_limit' | 'function_on_indexed_column' | 'implicit_type_conversion' | 'non_sargable_like';
  description: string;
  suggestion: string;
  severity: 'low' | 'medium' | 'high';
}

export interface IndexSuggestion {
  table: string;
  columns: string[];
  reason: string;
  queryPattern: string;
}

export interface QueryAnalysisResult {
  antiPatterns: QueryAntiPattern[];
  indexSuggestions: IndexSuggestion[];
  tableReferences: string[];
  estimatedRows?: number;
}

const TABLE_INDEX_HINTS: Record<string, { columns: string[]; reason: string }[]> = {
  payments: [
    { columns: ['tenant_id', 'status'], reason: 'Dashboard filters by tenant and payment status' },
    { columns: ['tenant_id', 'created_at'], reason: 'Paginated payment history per tenant' },
    { columns: ['user_id', 'created_at'], reason: 'User payment history ordered by date' },
    { columns: ['tenant_id', 'type'], reason: 'Payment type filtering per tenant' },
    { columns: ['project_id', 'created_at'], reason: 'Project payments ordered chronologically' },
    { columns: ['status', 'created_at'], reason: 'Oldest pending payments for processing' },
  ],
  projects: [
    { columns: ['tenant_id', 'status'], reason: 'Active/archived project listings' },
    { columns: ['tenant_id', 'created_at'], reason: 'Recent projects per tenant' },
  ],
  invoices: [
    { columns: ['tenant_id', 'status'], reason: 'Invoice dashboard status filters' },
    { columns: ['tenant_id', 'due_at'], reason: 'Overdue invoice queries' },
    { columns: ['tenant_id', 'generated_at'], reason: 'Generated invoice listings per tenant' },
    { columns: ['project_id', 'created_at'], reason: 'Project invoices ordered by date' },
  ],
  milestones: [
    { columns: ['project_id', 'status'], reason: 'Milestone progress tracking per project' },
    { columns: ['project_id', 'order'], reason: 'Ordered milestone rendering' },
  ],
  webhooks: [
    { columns: ['tenant_id', 'status'], reason: 'Active webhook endpoints per tenant' },
  ],
  outbox_events: [
    { columns: ['status', 'attempts'], reason: 'Retry queue prioritization' },
    { columns: ['status', 'created_at'], reason: 'Oldest pending events for processing' },
    { columns: ['aggregate_type', 'aggregate_id'], reason: 'Event stream lookup by aggregate' },
    { columns: ['event_type', 'created_at'], reason: 'Events filtered by type chronologically' },
  ],
  audit_logs: [
    { columns: ['entity_id', 'created_at'], reason: 'Audit trail per entity ordered chronologically' },
    { columns: ['actor', 'action', 'timestamp'], reason: 'Actor action audit queries' },
    { columns: ['entity_type', 'action'], reason: 'Resource type + action audit filtering' },
    { columns: ['user_id', 'created_at'], reason: 'User-specific audit history' },
  ],
  webhook_subscriptions: [
    { columns: ['tenant_id', 'status'], reason: 'Active webhook subscriptions per tenant' },
  ],
  webhook_subscription_deliveries: [
    { columns: ['subscription_id', 'created_at'], reason: 'Delivery history per subscription' },
    { columns: ['status', 'created_at'], reason: 'Failed delivery retry queue' },
  ],
  payment_vaults: [
    { columns: ['tenant_id', 'status'], reason: 'Vault status filtering per tenant' },
  ],
  vault_milestones: [
    { columns: ['vault_id', 'status'], reason: 'Vault milestone status tracking' },
  ],
  atomic_swaps: [
    { columns: ['tenant_id', 'status'], reason: 'Atomic swap status per tenant' },
    { columns: ['sender', 'status'], reason: 'Sender swap history with status' },
    { columns: ['receiver', 'status'], reason: 'Receiver swap history with status' },
  ],
  treasury_proposals: [
    { columns: ['tenant_id', 'status'], reason: 'Treasury proposals filtered by tenant and status' },
    { columns: ['status', 'execute_after'], reason: 'Pending proposals nearing execution' },
  ],
  email_deliveries: [
    { columns: ['tenant_id', 'status'], reason: 'Email delivery status per tenant' },
    { columns: ['tenant_id', 'sent_at'], reason: 'Recent sends per tenant' },
    { columns: ['recipient_email'], reason: 'Delivery history for a recipient' },
    { columns: ['template_id', 'created_at'], reason: 'Template usage analytics' },
  ],
  notification_logs: [
    { columns: ['tenant_id', 'user_id', 'status'], reason: 'Per-user notification statuses' },
    { columns: ['status', 'sent_at'], reason: 'Failed notification retry queue' },
    { columns: ['category', 'created_at'], reason: 'Category-based notification analytics' },
  ],
  push_subscriptions: [
    { columns: ['tenant_id', 'user_id'], reason: 'Lookup subscriptions per user' },
    { columns: ['is_active'], reason: 'Active subscription enumeration' },
  ],
  api_key_usage: [
    { columns: ['key_id', 'recorded_at'], reason: 'API key usage timeline' },
    { columns: ['tenant_id', 'recorded_at'], reason: 'Tenant-wide usage rollups' },
  ],
  bridge_messages: [
    { columns: ['status', 'initiated_at'], reason: 'Stuck bridge message detection' },
    { columns: ['source_chain', 'destination_chain', 'initiated_at'], reason: 'Cross-chain traffic analytics' },
  ],
  bridge_alerts: [
    { columns: ['message_id'], reason: 'Alerts per bridge message' },
    { columns: ['severity', 'acknowledged'], reason: 'Unacknowledged high-severity alerts' },
  ],
  bulk_uploads: [
    { columns: ['tenant_id', 'status', 'created_at'], reason: 'Upload listing per tenant filtered by status' },
  ],
  bulk_upload_rows: [
    { columns: ['bulk_upload_id', 'status'], reason: 'Per-upload row status breakdown' },
  ],
  fee_schedules: [
    { columns: ['tenant_id', 'status'], reason: 'Active fee schedules per tenant' },
    { columns: ['tenant_id', 'effective_from', 'effective_to'], reason: 'Scheduled fee lookups within date range' },
  ],
  indexed_events: [
    { columns: ['chain', 'contract_address', 'event_type'], reason: 'Contract event filtering' },
    { columns: ['chain', 'contract_address', 'timestamp'], reason: 'Time-ordered contract events' },
    { columns: ['retention_until'], reason: 'Event retention / cleanup job' },
  ],
  routing_decisions: [
    { columns: ['tenant_id', 'created_at'], reason: 'Routing decision history per tenant' },
    { columns: ['selected_chain', 'created_at'], reason: 'Chain selection analytics' },
  ],
  chain_performance_metrics: [
    { columns: ['chain', 'sample_at'], reason: 'Time-series performance per chain' },
  ],
  pii_audit_logs: [
    { columns: ['tenant_id', 'created_at'], reason: 'PII audit timeline per tenant' },
    { columns: ['pii_type', 'created_at'], reason: 'PII type frequency analysis' },
    { columns: ['endpoint', 'created_at'], reason: 'Per-endpoint PII detection rates' },
  ],
  reorg_events: [
    { columns: ['network', 'detected_at'], reason: 'Chain reorg timeline per network' },
    { columns: ['status'], reason: 'Unresolved reorg enumeration' },
  ],
  transaction_reorgs: [
    { columns: ['payment_id'], reason: 'Reorg history per payment' },
    { columns: ['status'], reason: 'Re-verification queue' },
  ],
  contract_upgrades: [
    { columns: ['network', 'contract_name'], reason: 'Upgrade lookup by network and contract' },
    { columns: ['status'], reason: 'In-progress upgrade tracking' },
  ],
  revenue_pools: [
    { columns: ['tenant_id'], reason: 'Revenue pools per tenant' },
  ],
  paymaster_budgets: [
    { columns: ['tenant_id', 'chain_id', 'token'], reason: 'Unique paymaster lookup' },
  ],
  user_operations: [
    { columns: ['sender'], reason: 'User ops by sender address' },
    { columns: ['status', 'created_at'], reason: 'Pending user op processing queue' },
  ],
  data_archives: [
    { columns: ['batch_id'], reason: 'Archive records per batch' },
    { columns: ['chain', 'tx_hash'], reason: 'On-chain record lookup' },
    { columns: ['block_number'], reason: 'Block-range archive queries' },
  ],
  archival_batches: [
    { columns: ['status'], reason: 'Archival job queue by status' },
    { columns: ['batch_date', 'chain'], reason: 'Unique batch lookup per chain and date' },
  ],
  price_anomaly_logs: [
    { columns: ['tenant_id', 'detected_at'], reason: 'Anomaly timeline per tenant' },
    { columns: ['severity'], reason: 'High-severity anomaly dashboard' },
  ],
  circuit_breaker_events: [
    { columns: ['tenant_id', 'pool_id'], reason: 'Circuit breaker per pool' },
    { columns: ['status'], reason: 'Active tripped breakers' },
  ],
  report_jobs: [
    { columns: ['tenant_id', 'status', 'created_at'], reason: 'Report job queue per tenant' },
  ],
  saved_reports: [
    { columns: ['tenant_id', 'updated_at'], reason: 'Recently edited reports per tenant' },
    { columns: ['tenant_id', 'is_favorite'], reason: 'Favorite reports per tenant' },
  ],
  scheduled_reports: [
    { columns: ['is_active', 'next_send_at'], reason: 'Scheduled report dispatch queue' },
  ],
};

export function extractTableNames(sql: string): string[] {
  const tables = new Set<string>();
  const normalized = sql.replace(/\s+/g, ' ').toLowerCase();

  const fromMatches = normalized.match(/from\s+"?([a-z_][a-z0-9_]*)"?/g);
  if (fromMatches) {
    fromMatches.forEach((m) => {
      const t = m.replace(/^from\s+"?/, '').replace(/"?$/, '');
      if (t !== 'pg_catalog' && t !== 'information_schema') tables.add(t);
    });
  }

  const joinMatches = normalized.match(/join\s+"?([a-z_][a-z0-9_]*)"?/g);
  if (joinMatches) {
    joinMatches.forEach((m) => {
      const t = m.replace(/^join\s+"?/, '').replace(/"?$/, '');
      tables.add(t);
    });
  }

  const updateMatches = normalized.match(/update\s+"?([a-z_][a-z0-9_]*)"?/g);
  if (updateMatches) {
    updateMatches.forEach((m) => {
      const t = m.replace(/^update\s+"?/, '').replace(/"?$/, '');
      tables.add(t);
    });
  }

  const insertMatches = normalized.match(/into\s+"?([a-z_][a-z0-9_]*)"?/g);
  if (insertMatches) {
    insertMatches.forEach((m) => {
      const t = m.replace(/^into\s+"?/, '').replace(/"?$/, '');
      tables.add(t);
    });
  }

  const deleteMatches = normalized.match(/delete\s+from\s+"?([a-z_][a-z0-9_]*)"?/g);
  if (deleteMatches) {
    deleteMatches.forEach((m) => {
      const t = m.replace(/^delete\s+from\s+"?/, '').replace(/"?$/, '');
      tables.add(t);
    });
  }

  return Array.from(tables);
}

export function extractWhereColumns(sql: string): string[] {
  const columns = new Set<string>();
  const normalized = sql.replace(/\s+/g, ' ');
  const whereMatch = normalized.match(/where\s+(.*?)(?:\s+group\s+by|\s+order\s+by|\s+limit|\s+having|;?$)/i);
  if (!whereMatch) return [];

  const whereClause = whereMatch[1];
  const colMatches = whereClause.match(/([a-z_][a-z0-9_]*)\s*(=|>|<|>=|<=|!=|<>|in|like|between|is)\s*/gi);
  if (colMatches) {
    colMatches.forEach((m) => {
      const col = m.split(/\s/)[0].toLowerCase();
      if (!['and', 'or', 'not', 'is', 'null', 'true', 'false', 'exists', 'any', 'all', 'some'].includes(col)) {
        columns.add(col);
      }
    });
  }

  const fkMatches = whereClause.match(/([a-z_][a-z0-9_]*_id)\s*/gi);
  if (fkMatches) {
    fkMatches.forEach((m) => columns.add(m.trim().toLowerCase()));
  }

  const onClauses = normalized.match(/on\s+([a-z_][a-z0-9_]*)\s*=\s*([a-z_][a-z0-9_]*)/gi);
  if (onClauses) {
    onClauses.forEach((m) => {
      const refs = m.match(/([a-z_][a-z0-9_]*)\s*=\s*([a-z_][a-z0-9_]*)/i);
      if (refs) {
        for (let i = 1; i <= 2; i++) {
          const col = refs[i].toLowerCase();
          if (col.includes('.') || col.endsWith('_id') || col === 'id') {
            const lastDot = col.lastIndexOf('.');
            columns.add(lastDot >= 0 ? col.slice(lastDot + 1) : col);
          }
        }
      }
    });
  }

  return Array.from(columns);
}

export function extractOrderByColumns(sql: string): string[] {
  const columns = new Set<string>();
  const normalized = sql.replace(/\s+/g, ' ');
  const orderMatch = normalized.match(/order\s+by\s+(.*?)(?:\s+limit|\s+offset|;?$)/i);
  if (!orderMatch) return [];

  const orderClause = orderMatch[1];
  const parts = orderClause.split(/\s*,\s*/);
  for (const part of parts) {
    const colMatch = part.match(/([a-z_][a-z0-9_]*)(?:\s+(?:asc|desc))?/i);
    if (colMatch) {
      const col = colMatch[1].toLowerCase();
      if (!['asc', 'desc', 'nulls', 'first', 'last'].includes(col)) {
        columns.add(col);
      }
    }
  }
  return Array.from(columns);
}

export function extractJoinColumns(sql: string): string[] {
  const columns = new Set<string>();
  const normalized = sql.replace(/\s+/g, ' ');
  const joinMatches = normalized.match(/join\s+[a-z_][a-z0-9_]*\s+(?:as\s+)?[a-z_][a-z0-9_]*\s+on\s+(.*?)(?:\s+where|\s+group|\s+order|\s+limit|\s+join\s|;?$)/gi);
  if (!joinMatches) return [];

  for (const jm of joinMatches) {
    const onMatch = jm.match(/on\s+(.*?)(?:\s+where|\s+group|\s+order|\s+limit|\s+join\s|;?$)/i);
    if (onMatch) {
      const refs = onMatch[1].match(/([a-z_][a-z0-9_]*)(?:\.[a-z_][a-z0-9_]*)?\s*=\s*[a-z_][a-z0-9_]*(?:\.[a-z_][a-z0-9_]*)?/gi);
      if (refs) {
        for (const r of refs) {
          const colRefs = r.match(/([a-z_][a-z0-9_]*)/gi);
          if (colRefs) {
            for (const cr of colRefs) {
              const col = cr.toLowerCase();
              if (col.endsWith('_id') || col === 'id') {
                columns.add(col);
              }
            }
          }
        }
      }
    }
  }
  return Array.from(columns);
}

export function extractGroupByColumns(sql: string): string[] {
  const columns = new Set<string>();
  const normalized = sql.replace(/\s+/g, ' ');
  const groupMatch = normalized.match(/group\s+by\s+(.*?)(?:\s+having|\s+order|\s+limit|;?$)/i);
  if (!groupMatch) return [];

  const groupClause = groupMatch[1];
  const parts = groupClause.split(/\s*,\s*/);
  for (const part of parts) {
    const colMatch = part.match(/([a-z_][a-z0-9_]*)/i);
    if (colMatch) {
      const col = colMatch[1].toLowerCase();
      columns.add(col);
    }
  }
  return Array.from(columns);
}

export function detectQueryAntiPatterns(sql: string): QueryAntiPattern[] {
  const patterns: QueryAntiPattern[] = [];
  const normalized = sql.replace(/\s+/g, ' ').trim();

  if (/SELECT\s+\*/i.test(normalized)) {
    patterns.push({
      type: 'select_star',
      description: 'Query uses SELECT * which fetches unnecessary columns',
      suggestion: 'Explicitly list only the columns needed to reduce I/O and enable index-only scans',
      severity: 'medium',
    });
  }

  const isSelect = /^SELECT\b/i.test(normalized);
  const hasWhere = /\bWHERE\b/i.test(normalized);
  const hasJoin = /\bJOIN\b/i.test(normalized);
  if (isSelect && !hasWhere && !hasJoin) {
    patterns.push({
      type: 'missing_where',
      description: 'SELECT query without WHERE clause may scan the entire table',
      suggestion: 'Add a WHERE clause to filter rows early, or confirm this full-table scan is intentional',
      severity: 'high',
    });
  }

  const distinctCount = (normalized.match(/\bDISTINCT\b/gi) || []).length;
  if (distinctCount > 0) {
    const orderByWithoutLimit = /\bORDER\s+BY\b(?!.*\bLIMIT\b)/i.test(normalized);
    if (distinctCount >= 2 || (distinctCount === 1 && orderByWithoutLimit)) {
      patterns.push({
        type: 'distinct_overuse',
        description: 'DISTINCT with multiple columns or large datasets causes expensive sort operations',
        suggestion: 'Consider using GROUP BY, EXISTS, or a subquery instead of DISTINCT for deduplication',
        severity: 'medium',
      });
    }
  }

  if (isSelect && /\bORDER\s+BY\b/i.test(normalized) && !/\bLIMIT\b/i.test(normalized)) {
    patterns.push({
      type: 'order_by_without_limit',
      description: 'ORDER BY without LIMIT requires sorting the entire result set',
      suggestion: 'Add a LIMIT clause if only top N rows are needed, or ensure an index covers the ORDER BY columns',
      severity: 'low',
    });
  }

  const functionOnCol = normalized.match(/(LOWER|UPPER|COALESCE|DATE_TRUNC|TO_CHAR|EXTRACT|TRUNC|ROUND|ABS|CEIL|FLOOR|LENGTH|SUBSTRING|CONCAT)\s*\(\s*([a-z_][a-z0-9_]*)\s*\)/i);
  if (functionOnCol) {
    patterns.push({
      type: 'function_on_indexed_column',
      description: `Function ${functionOnCol[1]}() wrapping column "${functionOnCol[2]}" prevents index usage`,
      suggestion: `Use a functional/expression index on ${functionOnCol[1]}(${functionOnCol[2]}) or restructure the predicate to avoid wrapping the column`,
      severity: 'high',
    });
  }

  const badLike = normalized.match(/LIKE\s+'%[^']+/i);
  if (badLike) {
    patterns.push({
      type: 'non_sargable_like',
      description: 'LIKE pattern with leading wildcard cannot use a B-tree index',
      suggestion: 'Consider trigram/GIN indexes for prefix searches, a full-text search index, or restructure to avoid the leading wildcard',
      severity: 'medium',
    });
  }

  const implicitCast = normalized.match(/([a-z_][a-z0-9_]*)\s*=\s*(?:'[^']*'|\d+\.?\d*)/i);
  if (implicitCast) {
    const col = implicitCast[1].toLowerCase();
    const value = normalized.slice(implicitCast.index || 0, (implicitCast.index || 0) + 80);
    const isStringColumn = /(_id|address|email|name|status|type|hash|key|url|uuid)$/.test(col);
    const isNumericValue = /=\s*\d+\.?\d*/.test(value);
    if (isStringColumn && isNumericValue) {
      patterns.push({
        type: 'implicit_type_conversion',
        description: `Column "${col}" appears to be compared to a value of a different type, forcing implicit cast`,
        suggestion: `Ensure the parameter type matches "${col}" column type to avoid implicit casts that bypass indexes`,
        severity: 'high',
      });
    }
  }

  const stringColPatterns = normalized.match(/([a-z_][a-z0-9_]*_id)\s*=\s*'[^']*'/gi);
  if (stringColPatterns) {
    for (const match of stringColPatterns) {
      const valPart = match.match(/=\s*'(\d+)'/);
      if (valPart && /^\d+$/.test(valPart[1])) {
        const col = match.split(/\s*=/)[0].trim().toLowerCase();
        patterns.push({
          type: 'implicit_type_conversion',
          description: `ID column "${col}" is compared to a numeric string literal — may trigger cast`,
          suggestion: `Pass ${col} as a proper parameter instead of a quoted numeric string to allow index usage`,
          severity: 'medium',
        });
        break;
      }
    }
  }

  return patterns;
}

export function suggestIndexes(sql: string): IndexSuggestion[] {
  const suggestions: IndexSuggestion[] = [];
  const tables = extractTableNames(sql);
  const whereCols = extractWhereColumns(sql);
  const orderByCols = extractOrderByColumns(sql);
  const joinCols = extractJoinColumns(sql);
  const groupByCols = extractGroupByColumns(sql);

  const allCols = new Set([...whereCols, ...orderByCols, ...joinCols, ...groupByCols]);
  if (tables.length === 0) return suggestions;

  for (const table of tables) {
    const hints = TABLE_INDEX_HINTS[table];
    if (!hints) continue;

    for (const hint of hints) {
      let score = 0;
      for (const c of hint.columns) {
        for (const ac of allCols) {
          if (c === ac ||
              c.endsWith(`_${ac}`) ||
              ac.endsWith(`_${c}`) ||
              ac === c.replace(/_/g, '') ||
              c === ac.replace(/_/g, '')) {
            score += whereCols.includes(ac) ? 3 : 1;
          }
        }
      }
      if (score > 0) {
        const querySig = querySignature(sql);
        if (!suggestions.some((s) => s.table === table && s.columns.join(',') === hint.columns.join(','))) {
          suggestions.push({
            table,
            columns: hint.columns,
            reason: hint.reason,
            queryPattern: querySig,
          });
        }
      }
    }
  }

  return suggestions.sort((a, b) => {
    const scoreA = a.columns.length;
    const scoreB = b.columns.length;
    return scoreB - scoreA;
  });
}

export function analyzeQuery(sql: string): QueryAnalysisResult {
  const antiPatterns = detectQueryAntiPatterns(sql);
  const indexSuggestions = suggestIndexes(sql);
  const tableReferences = extractTableNames(sql);

  return {
    antiPatterns,
    indexSuggestions,
    tableReferences,
  };
}

// ── N+1 Query Detection ────────────────────────────────────────────────────

export interface NPlusOneCandidate {
  baseQuery: string;
  repeatedPattern: string;
  count: number;
  timeWindowMs: number;
  detectedAt: string;
}

interface RecentQuery {
  signature: string;
  timestamp: number;
  query: string;
}

const recentQueries: RecentQuery[] = [];
const MAX_RECENT_QUERIES = 500;
const N_PLUS_ONE_WINDOW_MS = 5000;
const N_PLUS_ONE_THRESHOLD = 5;

function recordRecentQuery(query: string): void {
  const now = Date.now();
  recentQueries.push({
    signature: querySignature(query),
    timestamp: now,
    query,
  });
  if (recentQueries.length > MAX_RECENT_QUERIES) {
    recentQueries.splice(0, recentQueries.length - MAX_RECENT_QUERIES);
  }
  while (recentQueries.length > 0 && now - recentQueries[0].timestamp > N_PLUS_ONE_WINDOW_MS * 2) {
    recentQueries.shift();
  }
}

export function detectNPlusOne(query: string): NPlusOneCandidate | null {
  recordRecentQuery(query);
  const now = Date.now();
  const windowStart = now - N_PLUS_ONE_WINDOW_MS;

  const inWindow = recentQueries.filter((q) => q.timestamp >= windowStart);
  if (inWindow.length < N_PLUS_ONE_THRESHOLD + 1) return null;

  const sigCounts = new Map<string, { count: number; first: RecentQuery }>();
  for (const q of inWindow) {
    const existing = sigCounts.get(q.signature);
    if (existing) {
      existing.count++;
    } else {
      sigCounts.set(q.signature, { count: 1, first: q });
    }
  }

  for (const [sig, data] of sigCounts.entries()) {
    if (data.count >= N_PLUS_ONE_THRESHOLD) {
      const base = inWindow.find((q) => q.signature !== sig);
      return {
        baseQuery: base ? querySignature(base.query) : 'unknown',
        repeatedPattern: sig,
        count: data.count,
        timeWindowMs: N_PLUS_ONE_WINDOW_MS,
        detectedAt: new Date().toISOString(),
      };
    }
  }

  return null;
}

export function resetNPlusOneDetector(): void {
  recentQueries.length = 0;
}

// ── Wire analysis into the Prisma query listener ────────────────────────────

const nPlusOneDetections: NPlusOneCandidate[] = [];
const MAX_N_PLUS_ONE_DETECTIONS = 50;

export function getNPlusOneDetections(): NPlusOneCandidate[] {
  return [...nPlusOneDetections];
}

const analysisReports: Array<{ query: string; analysis: QueryAnalysisResult; durationMs: number; timestamp: string }> = [];
const MAX_ANALYSIS_REPORTS = 100;

export function getAnalysisReports(): typeof analysisReports {
  return [...analysisReports];
}

export function getOptimizationSummary() {
  const antiPatternCounts = new Map<string, number>();
  for (const r of analysisReports) {
    for (const ap of r.analysis.antiPatterns) {
      antiPatternCounts.set(ap.type, (antiPatternCounts.get(ap.type) || 0) + 1);
    }
  }

  const indexCounts = new Map<string, number>();
  for (const r of analysisReports) {
    for (const idx of r.analysis.indexSuggestions) {
      const key = `${idx.table}(${idx.columns.join(',')})`;
      indexCounts.set(key, (indexCounts.get(key) || 0) + 1);
    }
  }

  return {
    totalQueriesAnalyzed: analysisReports.length,
    queriesWithAntiPatterns: analysisReports.filter((r) => r.analysis.antiPatterns.length > 0).length,
    queriesWithIndexSuggestions: analysisReports.filter((r) => r.analysis.indexSuggestions.length > 0).length,
    nPlusOneDetected: nPlusOneDetections.length,
    antiPatternBreakdown: Object.fromEntries(antiPatternCounts.entries()),
    topIndexSuggestions: Array.from(indexCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([key, count]) => ({ index: key, count })),
  };
}

function analyzedPrismaListener(original: ReturnType<typeof createPrismaQueryListener>) {
  return (event: QueryEvent) => {
    original(event);

    if (event.duration >= config.slowThresholdMs) {
      const analysis = analyzeQuery(event.query);
      analysisReports.push({
        query: event.query.slice(0, 500),
        analysis,
        durationMs: event.duration,
        timestamp: new Date().toISOString(),
      });
      if (analysisReports.length > MAX_ANALYSIS_REPORTS) analysisReports.shift();

      if (analysis.antiPatterns.length > 0 && event.duration >= config.criticalThresholdMs) {
        console.warn(
          `[QueryLogger] Anti-patterns detected in slow query: ${analysis.antiPatterns.map((a) => a.type).join(', ')}`,
        );
      }
    }

    const nPlusOne = detectNPlusOne(event.query);
    if (nPlusOne) {
      nPlusOneDetections.push(nPlusOne);
      if (nPlusOneDetections.length > MAX_N_PLUS_ONE_DETECTIONS) nPlusOneDetections.shift();
      if (shouldAlert(`n+1:${nPlusOne.repeatedPattern}`)) {
        console.warn(
          `[QueryLogger] N+1 pattern detected: ${nPlusOne.count} repeated queries within ${nPlusOne.timeWindowMs}ms`,
        );
      }
    }
  };
}

export function createAnalyzedPrismaQueryListener() {
  return analyzedPrismaListener(createPrismaQueryListener());
}

export function attachAnalyzedQueryLogger(prisma: { $on: (event: string, handler: (e: QueryEvent) => void) => void }): void {
  prisma.$on('query', createAnalyzedPrismaQueryListener());
  console.log('[QueryLogger] Analyzed query logger attached to Prisma client');
}

export function resetAnalysisState(): void {
  resetNPlusOneDetector();
  nPlusOneDetections.length = 0;
  analysisReports.length = 0;
  resetQueryMetrics();
}