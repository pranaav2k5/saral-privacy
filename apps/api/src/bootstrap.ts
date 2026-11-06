import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module.js";

/**
 * Settings every instance of the app needs, in production and in tests. CORS reflects the caller's origin because the
 * browser SDK runs on tenants' own sites; it is not authorisation. Keys are checked on every request, a publishable key
 * can be limited to origins, and cookies are never allowed (`credentials` stays off).
 */
export function configureApp(app: INestApplication): void {
  app.enableCors({ origin: true, methods: ["GET", "POST", "DELETE", "OPTIONS"], allowedHeaders: ["Authorization", "Content-Type", "Idempotency-Key"], maxAge: 600 });
}

/**
 * Builds the application with shutdown hooks on. As PID 1 in a container, Node ignores
 * SIGTERM unless a handler is registered, so `docker stop` would otherwise wait for SIGKILL.
 */
export async function createApp(): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule);
  configureApp(app);
  app.enableShutdownHooks();
  return app;
}
