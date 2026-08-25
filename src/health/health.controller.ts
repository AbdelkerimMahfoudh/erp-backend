import { Controller, Get, VERSION_NEUTRAL } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { HealthCheck, HealthCheckService } from '@nestjs/terminus';
import { Public } from '../common/decorators/public.decorator';
import { PrismaHealthIndicator } from './prisma.health';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Liveness, readiness and build identity.
 *
 * **Nothing here discloses a secret.** No connection string, no credential, no
 * stack trace, no tenant data. That restraint is the point: a health endpoint
 * is the one route that is deliberately unauthenticated and reachable from
 * anywhere a load balancer sits, so anything it returns is effectively public.
 */
@Public()
@ApiTags('health')
@Controller({ path: 'health', version: VERSION_NEUTRAL })
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly db: PrismaHealthIndicator,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Liveness: is the process up and can it reach its database.
   *
   * What a restart policy watches. Deliberately cheap — a liveness probe that
   * does real work restarts a container that was merely busy.
   */
  @Get()
  @HealthCheck()
  check() {
    return this.health.check([() => this.db.pingCheck('database')]);
  }

  /**
   * Readiness: should traffic be sent here *yet*.
   *
   * Distinct from liveness because a process can be perfectly alive and still
   * unready — most usefully while its migrations are behind the code, which is
   * exactly the window in which a deployment would otherwise start serving
   * requests against a schema that has not caught up.
   */
  @Get('ready')
  async ready() {
    let migrationsApplied: number | null = null;
    let pendingMigrations: number | null = null;
    let databaseReachable = false;

    try {
      const rows = await this.prisma.$queryRawUnsafe<{ n: bigint }[]>(
        'SELECT COUNT(*) AS n FROM _prisma_migrations WHERE finished_at IS NOT NULL',
      );
      migrationsApplied = Number(rows[0]?.n ?? 0);

      const failed = await this.prisma.$queryRawUnsafe<{ n: bigint }[]>(
        'SELECT COUNT(*) AS n FROM _prisma_migrations WHERE finished_at IS NULL',
      );
      pendingMigrations = Number(failed[0]?.n ?? 0);
      databaseReachable = true;
    } catch {
      // Swallowed on purpose: the shape below reports "not ready" without
      // handing an unauthenticated caller a database error message.
      databaseReachable = false;
    }

    const ready = databaseReachable && pendingMigrations === 0;

    return {
      ready,
      databaseReachable,
      migrationsApplied,
      pendingMigrations,
      environment: process.env.APP_ENV ?? process.env.NODE_ENV ?? 'development',
      checkedAt: new Date().toISOString(),
    };
  }

  /**
   * What is actually deployed here.
   *
   * The commit is injected at build time. Without it, "is staging running the
   * fix?" is a question nobody can answer from outside the box.
   */
  @Get('version')
  version() {
    return {
      commit: process.env.APP_COMMIT ?? 'unknown',
      builtAt: process.env.APP_BUILT_AT ?? null,
      environment: process.env.APP_ENV ?? process.env.NODE_ENV ?? 'development',
    };
  }
}
