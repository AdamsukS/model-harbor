export type AdmissionErrorCode = 'USER_LIMIT' | 'QUEUE_FULL';

export class AdmissionError extends Error {
  constructor(
    readonly code: AdmissionErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'AdmissionError';
  }
}

export interface AdmissionQueueOptions {
  concurrency: number;
  queueSize: number;
  maxUsers: number;
}

export interface AdmissionSnapshot {
  active: number;
  queued: number;
  admittedUsers: number;
}

interface QueuedOperation<T> {
  userId: string;
  operation: () => Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
  cleanup?: () => void;
}

export class AdmissionQueue {
  private active = 0;
  private readonly pending: QueuedOperation<unknown>[] = [];
  private readonly userOperations = new Map<string, number>();

  constructor(private readonly options: AdmissionQueueOptions) {
    for (const [name, value] of Object.entries(options)) {
      if (!Number.isSafeInteger(value) || value < 1) {
        throw new Error(`${name} must be a positive integer.`);
      }
    }
  }

  run<T>(userId: string, operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    const normalizedUserId = userId.trim();
    if (!normalizedUserId) return Promise.reject(new Error('userId must not be empty.'));
    if (this.active + this.pending.length >= this.options.queueSize) {
      return Promise.reject(new AdmissionError('QUEUE_FULL', 'The local inference queue is full.'));
    }
    if (!this.userOperations.has(normalizedUserId) && this.userOperations.size >= this.options.maxUsers) {
      return Promise.reject(
        new AdmissionError('USER_LIMIT', 'The local service already has the maximum admitted users.')
      );
    }

    this.userOperations.set(
      normalizedUserId,
      (this.userOperations.get(normalizedUserId) ?? 0) + 1
    );
    const result = new Promise<T>((resolve, reject) => {
      const entry = {
        userId: normalizedUserId,
        operation,
        resolve,
        reject,
      } as QueuedOperation<unknown>;
      if (signal) {
        const abort = () => {
          const index = this.pending.indexOf(entry);
          if (index < 0) return;
          this.pending.splice(index, 1);
          entry.cleanup?.();
          this.releaseUser(normalizedUserId);
          reject(signal.reason);
        };
        signal.addEventListener('abort', abort, { once: true });
        entry.cleanup = () => signal.removeEventListener('abort', abort);
      }
      this.pending.push(entry);
    });
    this.pump();
    return result;
  }

  snapshot(): AdmissionSnapshot {
    return {
      active: this.active,
      queued: this.pending.length,
      admittedUsers: this.userOperations.size,
    };
  }

  private pump(): void {
    while (this.active < this.options.concurrency) {
      const next = this.pending.shift();
      if (!next) return;
      next.cleanup?.();
      this.active += 1;
      void Promise.resolve()
        .then(next.operation)
        .then(next.resolve, next.reject)
        .finally(() => {
          this.active -= 1;
          this.releaseUser(next.userId);
          this.pump();
        });
    }
  }

  private releaseUser(userId: string): void {
    const remaining = (this.userOperations.get(userId) ?? 1) - 1;
    if (remaining === 0) this.userOperations.delete(userId);
    else this.userOperations.set(userId, remaining);
  }
}
