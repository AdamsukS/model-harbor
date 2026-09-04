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
  thinking: boolean;
  timeoutMs: number;
}

export interface InferenceResult {
  content: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  toolCalls?: ToolCall[];
}

export interface ToolCall {
  function: { name: string; arguments: Record<string, unknown> };
}

export interface ToolDefinition {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface InferenceMessage {
  role: ChatMessage['role'] | 'tool';
  content: string;
  tool_calls?: ToolCall[];
  tool_name?: string;
}

export interface InferenceClient {
  health(signal?: AbortSignal): Promise<{ modelAvailable: boolean }>;
  chat(messages: readonly InferenceMessage[], signal?: AbortSignal, tools?: ToolDefinition[]): Promise<InferenceResult>;
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

  async chat(messages: readonly InferenceMessage[], signal?: AbortSignal, tools?: ToolDefinition[]): Promise<InferenceResult> {
    const payload = await this.request(
      '/api/chat',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.options.model,
          messages,
          stream: false,
          think: this.options.thinking,
          ...(tools?.length ? { tools } : {}),
          options: { num_ctx: this.options.contextTokens },
        }),
      },
      signal
    );
    if (!isRecord(payload) || !isRecord(payload.message)) {
      throw new DependencyError('ollama', 'Ollama returned an invalid chat response.');
    }
    const content = payload.message.content;
    const calls = payload.message.tool_calls;
    if (calls !== undefined && (!Array.isArray(calls) || calls.some((call) =>
      !isRecord(call) || !isRecord(call.function) ||
      typeof call.function.name !== 'string' || !isRecord(call.function.arguments)
    ))) throw new DependencyError('ollama', 'Ollama returned invalid tool calls.');
    const toolCalls = calls as ToolCall[] | undefined;
    if ((typeof content !== 'string' || content.trim() === '') && !toolCalls?.length) {
      throw new DependencyError('ollama', 'Ollama returned empty assistant content.');
    }
    return {
      content: typeof content === 'string' ? content : '',
      model: typeof payload.model === 'string' ? payload.model : this.options.model,
      promptTokens: integerOrZero(payload.prompt_eval_count),
      completionTokens: integerOrZero(payload.eval_count),
      ...(toolCalls?.length ? { toolCalls } : {}),
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
