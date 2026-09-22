import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { describe, expect, it } from 'vitest';
import { AuthController } from '../auth/auth.controller';
import { AppError } from '../common/errors';
import { AdminDrawsController } from '../draws/admin-draws.controller';
import { DrawsController } from '../draws/draws.controller';
import { HealthController } from '../health/health.controller';
import { AdminMarketsController } from '../markets/admin-markets.controller';
import { MarketsController } from '../markets/markets.controller';
import { ACCESS_POLICY, type AccessPolicy, Public } from './access';
import { AccessGuard } from './access.guard';

// Collaborators must never be reached for these policies; any call fails the test.
const unreachable = new Proxy(
  {},
  {
    get: () => {
      throw new Error('collaborator must not be called');
    },
  },
);

function contextFor(handler: () => void, controller: new () => object): ExecutionContext {
  return {
    getHandler: () => handler,
    getClass: () => controller,
    switchToHttp: () => ({ getRequest: () => ({ method: 'GET', url: '/test' }) }),
  } as unknown as ExecutionContext;
}

describe('AccessGuard: deny by default', () => {
  const guard = new AccessGuard(
    new Reflector(),
    unreachable as never,
    unreachable as never,
    unreachable as never,
    unreachable as never,
  );

  it('denies a route that declares no access policy', async () => {
    class Undecorated {}
    const attempt = guard.canActivate(contextFor(() => undefined, Undecorated));
    await expect(attempt).rejects.toBeInstanceOf(AppError);
    await expect(attempt).rejects.toMatchObject({ status: 403, code: 'FORBIDDEN' });
  });

  it('allows a public route without touching sessions or RBAC', async () => {
    @Public()
    class Open {}
    await expect(guard.canActivate(contextFor(() => undefined, Open))).resolves.toBe(true);
  });
});

describe('route conformance', () => {
  const reflector = new Reflector();
  const controllers = [
    HealthController,
    MarketsController,
    AdminMarketsController,
    AuthController,
    DrawsController,
    AdminDrawsController,
  ];

  const routes = controllers.flatMap((controller) =>
    Object.getOwnPropertyNames(controller.prototype)
      .map((name) => ({
        controller,
        name,
        handler: (controller.prototype as unknown as Record<string, unknown>)[name] as () => void,
      }))
      .filter(
        ({ handler }) =>
          typeof handler === 'function' && Reflect.hasMetadata(METHOD_METADATA, handler),
      ),
  );

  it('finds the routes', () => {
    expect(routes.length).toBeGreaterThanOrEqual(24);
  });

  it('declares an access policy on every route', () => {
    const missing = routes
      .filter(
        ({ controller, handler }) =>
          !reflector.getAllAndOverride<AccessPolicy>(ACCESS_POLICY, [handler, controller]),
      )
      .map(({ controller, name }) => `${controller.name}.${name}`);
    expect(missing).toEqual([]);
  });

  it('requires a sensitive-operation policy on every admin mutation', () => {
    const adminMutations = routes.filter(
      ({ controller, handler }) =>
        controller === AdminMarketsController &&
        (Reflect.getMetadata(METHOD_METADATA, handler) as number) !== 0, // 0 = GET
    );
    expect(adminMutations.length).toBe(4);
    for (const { handler, controller } of adminMutations) {
      const policy = reflector.getAllAndOverride<AccessPolicy>(ACCESS_POLICY, [
        handler,
        controller,
      ]);
      expect(policy).toMatchObject({
        kind: 'permission',
        permission: 'markets.gate.manage',
        sensitive: true,
      });
    }
  });

  it('requires draws.write, scoped to the route market, on every admin draw mutation', () => {
    const mutations = routes.filter(
      ({ controller, handler }) =>
        controller === AdminDrawsController &&
        (Reflect.getMetadata(METHOD_METADATA, handler) as number) !== 0,
    );
    expect(mutations.length).toBe(6);
    for (const { handler, controller } of mutations) {
      expect(
        reflector.getAllAndOverride<AccessPolicy>(ACCESS_POLICY, [handler, controller]),
      ).toMatchObject({
        kind: 'permission',
        permission: 'draws.write',
        scope: { param: 'market' },
      });
    }
  });

  it('exposes only health, market, draw and sign-in routes publicly', () => {
    const publicRoutes = routes
      .filter(
        ({ controller, handler }) =>
          reflector.getAllAndOverride<AccessPolicy>(ACCESS_POLICY, [handler, controller])?.kind ===
          'public',
      )
      .map(({ controller, handler }) =>
        [
          Reflect.getMetadata(PATH_METADATA, controller),
          Reflect.getMetadata(PATH_METADATA, handler),
        ]
          .map(String)
          .filter((part) => part !== '/')
          .join('/'),
      );
    expect(publicRoutes.sort()).toEqual([
      'auth/login',
      'auth/register',
      'health/live',
      'health/ready',
      'markets',
      'markets/:market',
      'markets/:market/draws',
      'markets/:market/draws/:slug',
    ]);
  });
});
