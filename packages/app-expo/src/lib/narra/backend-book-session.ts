import type { BackendBookBinding, BackendBookManifest } from "./backend-book-contract";
import { shouldPollBackendManifest } from "./backend-book-contract";

export interface BackendBookSessionDependencies {
  bind(signal: AbortSignal): Promise<BackendBookBinding>;
  progress(binding: BackendBookBinding, progress: number, signal: AbortSignal): Promise<unknown>;
  manifest(binding: BackendBookBinding, signal: AbortSignal): Promise<BackendBookManifest>;
  identity(
    binding: BackendBookBinding,
    signal: AbortSignal,
  ): Promise<{ pending: boolean; delay: number }>;
  publish(manifest: BackendBookManifest, progress: number): void;
  media(manifest: BackendBookManifest, progress: number, signal: AbortSignal): Promise<void>;
  error(error: unknown): void;
  expired(binding: BackendBookBinding): void;
  isNotFound(error: unknown): boolean;
  /** Ошибки, которые повтор не исправит (формат, размер, целостность загрузки). */
  isTerminal?(error: unknown): boolean;
}

/** One session per local book, independent identity/manifest work and a single progress high-water. */
export class BackendBookSession {
  private controller = new AbortController();
  private binding?: BackendBookBinding;
  private timer?: ReturnType<typeof setTimeout>;
  private identityTimer?: ReturnType<typeof setTimeout>;
  private progressTimer?: ReturnType<typeof setTimeout>;
  private busy = false;
  private pendingProgress: number;
  private sentProgress = -1;
  private errors = 0;
  private terminal = false;
  private currentProgress: number;
  private latest?: BackendBookManifest;
  private mediaBusy = false;
  private mediaPending = false;

  constructor(
    private readonly deps: BackendBookSessionDependencies,
    progress: number,
  ) {
    this.pendingProgress = this.currentProgress = this.normalize(progress);
  }
  private normalize(progress: number) {
    return Number.isFinite(progress) ? Math.max(0, Math.min(1, progress)) : 0;
  }
  start() {
    void this.refresh();
  }
  update(progress: number) {
    this.currentProgress = this.normalize(progress);
    this.pendingProgress = Math.max(this.pendingProgress, this.currentProgress);
    if (this.latest?.availability === "ready") this.deps.publish(this.latest, this.currentProgress);
    if (this.latest) this.loadMedia();
    if (this.pendingProgress <= this.sentProgress || this.progressTimer) return;
    this.progressTimer = setTimeout(() => {
      this.progressTimer = undefined;
      void this.refresh();
    }, 1500);
  }
  retry() {
    this.terminal = false;
    if (!this.controller.signal.aborted) void this.refresh();
  }
  stop() {
    this.controller.abort();
    clearTimeout(this.timer);
    clearTimeout(this.identityTimer);
    clearTimeout(this.progressTimer);
  }
  private async identity() {
    const binding = this.binding;
    if (!binding || binding.resolution !== "private" || this.controller.signal.aborted) return;
    let delay = 5000;
    try {
      const result = await this.deps.identity(binding, this.controller.signal);
      if (!result.pending) return;
      delay = Math.max(1000, result.delay);
    } catch (error) {
      if (this.controller.signal.aborted) return;
      this.deps.error(error);
    }
    if (!this.controller.signal.aborted && this.binding === binding)
      this.identityTimer = setTimeout(() => void this.identity(), delay);
  }
  private loadMedia() {
    if (this.mediaBusy) {
      this.mediaPending = true;
      return;
    }
    if (!this.latest || this.controller.signal.aborted) return;
    this.mediaBusy = true;
    this.mediaPending = false;
    void this.deps
      .media(this.latest, this.currentProgress, this.controller.signal)
      .catch((error) => {
        if (!this.controller.signal.aborted) this.deps.error(error);
      })
      .finally(() => {
        this.mediaBusy = false;
        if (this.mediaPending) this.loadMedia();
      });
  }
  private async refresh() {
    if (this.busy || this.terminal || this.controller.signal.aborted) return;
    this.busy = true;
    clearTimeout(this.timer);
    let delay: number | undefined;
    const signal = this.controller.signal;
    try {
      if (!this.binding) {
        this.binding = await this.deps.bind(signal);
        if (signal.aborted) return;
        void this.identity();
      }
      // A failed progress POST must not hide cached profiles or prevent a GET.
      if (this.pendingProgress > this.sentProgress) {
        const progress = this.pendingProgress;
        try {
          await this.deps.progress(this.binding, progress, signal);
          this.sentProgress = progress;
        } catch (error) {
          if (this.deps.isNotFound(error)) throw error;
          if (!signal.aborted) this.deps.error(error);
          delay = 5000;
        }
      }
      const manifest = await this.deps.manifest(this.binding, signal);
      if (signal.aborted) return;
      this.latest = manifest;
      this.deps.publish(manifest, this.currentProgress);
      this.loadMedia();
      this.errors = 0;
      if (shouldPollBackendManifest(manifest, this.currentProgress)) delay = 5000;
      if (manifest.availability === "unknown") delay = 30_000;
    } catch (error) {
      if (signal.aborted) return;
      this.deps.error(error);
      if (this.deps.isTerminal?.(error)) {
        // Неподдерживаемый формат, слишком большой файл, битая загрузка:
        // раньше сессия повторяла bind/PUT каждые 5–60 с до конца дедлайна,
        // заново отправляя весь файл. Останавливаемся до явного retry.
        this.terminal = true;
        this.pendingProgress = this.sentProgress;
        return;
      }
      if (this.binding?.resolution === "private" && this.deps.isNotFound(error)) {
        this.deps.expired(this.binding);
        this.binding = undefined;
        this.sentProgress = -1;
        clearTimeout(this.identityTimer);
      }
      delay = Math.min(60_000, 5000 * 2 ** this.errors++);
    } finally {
      this.busy = false;
      if (
        !signal.aborted &&
        !this.terminal &&
        (delay !== undefined || this.pendingProgress > this.sentProgress)
      )
        this.timer = setTimeout(() => void this.refresh(), delay ?? 1500);
    }
  }
}
