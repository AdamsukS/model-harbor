import { describe, expect, it } from 'vitest';
import { AdmissionError, AdmissionQueue } from '../src/admission-queue';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe('AdmissionQueue', () => {
  it('runs one operation at a time in FIFO order', async () => {
    const queue = new AdmissionQueue({ concurrency: 1, queueSize: 5, maxUsers: 5 });
    const firstGate = deferred<string>();
    const order: string[] = [];

    const first = queue.run('user-1', async () => {
      order.push('first:start');
      const value = await firstGate.promise;
      order.push('first:end');
      return value;
    });
    const second = queue.run('user-2', async () => {
      order.push('second');
      return 'second';
    });

    await Promise.resolve();
    expect(order).toEqual(['first:start']);
    expect(queue.snapshot()).toEqual({ active: 1, queued: 1, admittedUsers: 2 });

    firstGate.resolve('first');
    await expect(Promise.all([first, second])).resolves.toEqual(['first', 'second']);
    expect(order).toEqual(['first:start', 'first:end', 'second']);
    expect(queue.snapshot()).toEqual({ active: 0, queued: 0, admittedUsers: 0 });
  });

  it('counts repeated requests from one user as one admitted user', async () => {
    const queue = new AdmissionQueue({ concurrency: 1, queueSize: 3, maxUsers: 2 });
    const gate = deferred<void>();
    const requests = [
      queue.run('same-user', () => gate.promise),
      queue.run('same-user', async () => undefined),
      queue.run('same-user', async () => undefined),
    ];

    await Promise.resolve();
    expect(queue.snapshot().admittedUsers).toBe(1);
    gate.resolve();
    await Promise.all(requests);
  });

  it('rejects a sixth distinct admitted user', async () => {
    const queue = new AdmissionQueue({ concurrency: 1, queueSize: 6, maxUsers: 5 });
    const gate = deferred<void>();
    const admitted = Array.from({ length: 5 }, (_, index) =>
      queue.run(`user-${index + 1}`, index === 0 ? () => gate.promise : async () => undefined)
    );

    await expect(queue.run('user-6', async () => undefined)).rejects.toMatchObject({
      code: 'USER_LIMIT',
    } satisfies Partial<AdmissionError>);

    gate.resolve();
    await Promise.all(admitted);
  });

  it('rejects an operation when the total admitted queue is full', async () => {
    const queue = new AdmissionQueue({ concurrency: 1, queueSize: 2, maxUsers: 5 });
    const gate = deferred<void>();
    const first = queue.run('user-1', () => gate.promise);
    const second = queue.run('user-2', async () => undefined);

    await expect(queue.run('user-3', async () => undefined)).rejects.toMatchObject({
      code: 'QUEUE_FULL',
    } satisfies Partial<AdmissionError>);

    gate.resolve();
    await Promise.all([first, second]);
  });

  it('releases user accounting when an operation fails', async () => {
    const queue = new AdmissionQueue({ concurrency: 1, queueSize: 1, maxUsers: 1 });

    await expect(
      queue.run('user-1', async () => {
        throw new Error('operation failed');
      })
    ).rejects.toThrow('operation failed');

    await expect(queue.run('user-2', async () => 'accepted')).resolves.toBe('accepted');
  });
});
