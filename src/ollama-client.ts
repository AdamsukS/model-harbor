import type { ChatMessage } from './context';
import {
  DependencyError,
  isRecord,
  parseJsonResponse,
  requestSignal,
} from './dependency-error';

export interface OllamaClientOptions {
  baseUrl: string;
  model: string;
  contextTokens: number;
  timeoutMs: number;
}

export interface InferenceResult {
  content: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
}

export interface InferenceClient {
  health(signal?: AbortSignal): Promise<{ modelAvailable: boolean }>;
  chat(messages: readonly ChatMessage[], signal?: AbortSignal): Promise<InferenceResult>;
}

export class OllamaClient implements InferenceClient {
  constructor(private readonly options: OllamaClientOptions) {}

  async health(signal?: AbortSignal): Promise<{ modelAvailable: boolean }> {
    const payload = await this.request('/api/tags', { method: 'GET' }, signal);
    const models = isRecord(payload) && Array.isArray(payload.models) ? payload.models : [];
    return {
      modelAvailable: models.some(
        (candidate) =>
          isRecord(candidate) &&
          (candidate.name === this.options.model || candidate.model === this.options.model)
      ),
    };
  }

  async chat(messages: readonly ChatMessage[], signal?: AbortSignal): Promise<InferenceResult> {
    const payload = await this.request(
      '/api/chat',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.options.model,
          messages,
          stream: false,
          options: { num_ctx: this.options.contextTokens },
        }),
      },
      signal
    );
    if (!isRecord(payload) || !isRecord(payload.message)) {
      throw new DependencyError('ollama', 'Ollama returned an invalid chat response.');
    }
    const content = payload.message.content;
    if (typeof content !== 'string' || content.trim() === '') {
      throw new DependencyError('ollama', 'Ollama returned empty assistant content.');
    }
    return {
      content,
      model: typeof payload.model === 'string' ? payload.model : this.options.model,
      promptTokens: integerOrZero(payload.prompt_eval_count),
      completionTokens: integerOrZero(payload.eval_count),
    };
  }

  private async request(pathname: string, init: RequestInit, signal?: AbortSignal): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(`${this.options.baseUrl}${pathname}`, {
        ...init,
        signal: requestSignal(this.options.timeoutMs, signal),
      });
    } catch (error) {
      throw new DependencyError('ollama', 'Unable to reach Ollama.', undefined, { cause: error });
    }
    return parseJsonResponse('ollama', response);
  }
}

function integerOrZero(value: unknown): number {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : 0;
}
