import { Injectable, type OnApplicationBootstrap, type OnModuleDestroy } from "@nestjs/common";
import { WebhookWorker } from "./worker.js";

const DEFAULT_INTERVAL_MS = 5000;

/** Polls the outbox while the process runs. Off unless SARAL_WEBHOOK_WORKER=on, so tests and one-off processes stay quiet. */
@Injectable()
export class WebhookRunner implements OnApplicationBootstrap, OnModuleDestroy {
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  /** Read once at construction; tests set these directly. */
  enabled = process.env.SARAL_WEBHOOK_WORKER === "on";
  intervalMs = DEFAULT_INTERVAL_MS;

  constructor(private readonly worker: WebhookWorker) {}

  onApplicationBootstrap(): void {
    if (!this.enabled) return;
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.timer.unref();
  }

  /** One poll. A poll that is still running makes the next one skip, so slow endpoints cannot pile up work. */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.worker.runOnce(new Date());
    } catch (e) {
      console.error("webhook worker:", e instanceof Error ? e.message : e);
    } finally {
      this.running = false;
    }
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }
}
