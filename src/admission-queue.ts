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

  run<T>(userId: string, operation: () => Promise<T>): Promise<T> {
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
      this.pending.push({
        userId: normalizedUserId,
        operation,
        resolve,
        reject,
      } as QueuedOperation<unknown>);
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
      this.active += 1;
      void Promise.resolve()
        .then(next.operation)
        .then(next.resolve, next.reject)
        .finally(() => {
          this.active -= 1;
          const remaining = (this.userOperations.get(next.userId) ?? 1) - 1;
          if (remaining === 0) this.userOperations.delete(next.userId);
          else this.userOperations.set(next.userId, remaining);
          this.pump();
        });
    }
  }
}
