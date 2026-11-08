import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module.js";

/**
 * Settings every instance of the app needs, in production and in tests. CORS reflects the caller's origin because the
 * browser SDK runs on tenants' own sites; it is not authorisation. Keys are checked on every request, a publishable key
 * can be limited to origins, and cookies are never allowed (`credentials` stays off).
 */
export function configureApp(app: INestApplication, options: { trustProxy?: number } = {}): void {
  // Retry-After is exposed so a page can tell the person how long to wait after a 429.
  app.enableCors({ origin: true, methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"], allowedHeaders: ["Authorization", "Content-Type", "Idempotency-Key"], exposedHeaders: ["Retry-After"], maxAge: 600 });
  if (options.trustProxy !== undefined) (app.getHttpAdapter().getInstance() as { set(name: string, value: unknown): void }).set("trust proxy", options.trustProxy);
}

/**
 * Builds the application with shutdown hooks on. As PID 1 in a container, Node ignores
 * SIGTERM unless a handler is registered, so `docker stop` would otherwise wait for SIGKILL.
 */
export async function createApp(options: { trustProxy?: number } = {}): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule);
  configureApp(app, options);
  app.enableShutdownHooks();
  return app;
}
