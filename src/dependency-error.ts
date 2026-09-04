export class DependencyError extends Error {
  constructor(
    readonly dependency: 'ollama' | 'plasmod',
    message: string,
    readonly status?: number,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = 'DependencyError';
  }
}

export function requestSignal(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export async function parseJsonResponse(
  dependency: 'ollama' | 'plasmod',
  response: Response
): Promise<unknown> {
  const text = await response.text();
  let payload: unknown;
  try {
    payload = text ? (JSON.parse(text) as unknown) : {};
  } catch (error) {
    throw new DependencyError(
      dependency,
      `${dependency} returned malformed JSON.`,
      response.status,
      { cause: error }
    );
  }
  if (!response.ok) {
    throw new DependencyError(
      dependency,
      `${dependency} request failed with HTTP ${response.status}.`,
      response.status
    );
  }
  return payload;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
