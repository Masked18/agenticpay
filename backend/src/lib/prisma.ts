// Prisma client singleton — Issue #207
// Single shared instance with query logging, slow-query detection,
// anti-pattern analysis, N+1 detection, and index recommendations.

import { PrismaClient } from '@prisma/client';
import { SLOW_QUERY_THRESHOLD_MS, VERY_SLOW_QUERY_THRESHOLD_MS } from '../config/database.js';
import { withTenantIsolationGuard } from '../security/tenant-isolation/guard.js';
import { withEncryptionMiddleware } from '../encryption/index.js';
import {
  attachAnalyzedQueryLogger,
  configureQueryLogger,
} from '../middleware/queryLogger.js';

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

configureQueryLogger({
  slowThresholdMs: SLOW_QUERY_THRESHOLD_MS,
  criticalThresholdMs: VERY_SLOW_QUERY_THRESHOLD_MS,
});

const basePrismaClient =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: [
      { emit: 'event', level: 'query' },
      { emit: 'stdout', level: 'warn' },
      { emit: 'stdout', level: 'error' },
    ],
  });

// Cross-tenant isolation enforcement (Issue #522) — throws instead of
// silently leaking data when a query targets a tenant other than the
// caller's active tenant context.
// Column-level AES-256-GCM encryption for PII fields (Issue #511).
export const prisma = withEncryptionMiddleware(withTenantIsolationGuard(basePrismaClient));

// Attach analyzed query logger (slow query detection + anti-pattern analysis
// + N+1 detection + index suggestions) to Prisma query events. Must be
// registered on the base client — extended clients don't re-expose $on.
attachAnalyzedQueryLogger(
  basePrismaClient as unknown as {
    $on: (event: string, handler: (e: { query: string; params: string; duration: number; target: string; timestamp: Date }) => void) => void;
  },
);

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = basePrismaClient;
}

// Graceful disconnect helper — call in server shutdown handler
export async function disconnectPrisma(): Promise<void> {
  await prisma.$disconnect();
}

export { PrismaClient };
