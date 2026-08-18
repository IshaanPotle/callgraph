/**
 * Live provider — Claude via the official SDK.
 *
 * API notes that are easy to get wrong on Opus 5, all deliberate here:
 *   - `thinking: { type: "adaptive" }`. `budget_tokens` is a 400 on this model.
 *   - No `temperature` / `top_p` / `top_k` — all rejected with a 400.
 *   - No assistant-turn prefill to force JSON; `output_config.format` does it
 *     properly and validates on the way back.
 *   - Effort is `output_config.effort`, not a top-level field.
 *   - The system prompt is a single cached block. It is stable per agent, so
 *     across ~200 extraction calls the schema and instructions are read from
 *     cache at ~10% of input price. `cache_read_input_tokens` in the trace is
 *     the proof it actually worked.
 */

import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';

import { withRetry } from '../async.js';
import type { Tracer } from '../trace.js';
import { ModelRefusal, SchemaViolation, type GenerateRequest, type LlmProvider } from './provider.js';

/**
 * Opus 5's minimum cacheable prefix is 512 tokens. Below that a cache
 * breakpoint is silently ignored, so don't spend one.
 */
const MIN_CACHEABLE_CHARS = 512 * 4;

export interface AnthropicProviderOptions {
  model: string;
  tracer: Tracer;
  /** Applied when a request doesn't specify one. */
  defaultEffort?: GenerateRequest<unknown>['effort'];
  maxRetries?: number;
}

export class AnthropicProvider implements LlmProvider {
  readonly kind = 'anthropic' as const;
  readonly model: string;

  private client: Anthropic;
  private tracer: Tracer;
  private defaultEffort: NonNullable<GenerateRequest<unknown>['effort']>;
  private maxRetries: number;

  constructor(opts: AnthropicProviderOptions) {
    this.model = opts.model;
    this.tracer = opts.tracer;
    this.defaultEffort = opts.defaultEffort ?? 'high';
    this.maxRetries = opts.maxRetries ?? 3;
    // Resolves ANTHROPIC_API_KEY from the environment. The SDK's own retry is
    // disabled because we own the retry policy and want it in the trace.
    this.client = new Anthropic({ maxRetries: 0, timeout: 120_000 });
  }

  async generate<T>(req: GenerateRequest<T>): Promise<T> {
    const started = Date.now();
    let retries = 0;

    const system: Anthropic.TextBlockParam[] = [
      {
        type: 'text',
        text: req.system,
        ...(req.system.length >= MIN_CACHEABLE_CHARS
          ? { cache_control: { type: 'ephemeral' as const } }
          : {}),
      },
    ];

    try {
      const response = await withRetry(
        () =>
          this.client.messages.parse({
            model: this.model,
            max_tokens: req.maxTokens ?? 8000,
            thinking: { type: 'adaptive' },
            system,
            messages: [{ role: 'user', content: req.user }],
            output_config: {
              format: zodOutputFormat(req.schema),
              effort: req.effort ?? this.defaultEffort,
            },
          }),
        {
          attempts: this.maxRetries,
          retryable: isRetryable,
          onRetry: () => {
            retries += 1;
          },
        },
      );

      // Opus 5 has elevated safeguards; check before touching content.
      if (response.stop_reason === 'refusal') {
        throw new ModelRefusal(req.agent, response.stop_details?.category ?? null);
      }
      if (response.stop_reason === 'max_tokens') {
        throw new SchemaViolation(req.agent, 'hit max_tokens before completing the object');
      }
      if (response.parsed_output == null) {
        throw new SchemaViolation(req.agent, 'parsed_output was null');
      }

      this.tracer.record({
        agent: req.agent,
        callId: req.callId,
        model: this.model,
        provider: 'anthropic',
        startedAt: started,
        durationMs: Date.now() - started,
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
        cacheCreationTokens: response.usage.cache_creation_input_tokens ?? 0,
        retries,
        ok: true,
      });

      return response.parsed_output as T;
    } catch (err) {
      this.tracer.record({
        agent: req.agent,
        callId: req.callId,
        model: this.model,
        provider: 'anthropic',
        startedAt: started,
        durationMs: Date.now() - started,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        retries,
        ok: false,
        error: describe(err),
      });
      throw err;
    }
  }
}

/**
 * Retry transport and capacity failures; never retry a request the API has
 * already told us is malformed. In TypeScript `APIConnectionError` must be
 * checked before `APIError` — the subclass relationship is the opposite of
 * what the Python SDK trains you to expect.
 */
function isRetryable(err: unknown): boolean {
  if (err instanceof Anthropic.APIConnectionError) return true;
  if (err instanceof Anthropic.RateLimitError) return true;
  if (err instanceof Anthropic.InternalServerError) return true;
  if (err instanceof Anthropic.BadRequestError) return false;
  if (err instanceof Anthropic.AuthenticationError) return false;
  if (err instanceof Anthropic.PermissionDeniedError) return false;
  if (err instanceof Anthropic.NotFoundError) return false;
  if (err instanceof ModelRefusal) return false;
  // A schema violation is worth exactly one more shot: it's usually a
  // truncation or a formatting slip, not a systematic prompt defect.
  if (err instanceof SchemaViolation) return true;
  if (err instanceof Anthropic.APIError) return (err.status ?? 500) >= 500;
  return false;
}

function describe(err: unknown): string {
  if (err instanceof Anthropic.APIError) return `${err.name}(${err.status ?? '?'}): ${err.message}`;
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}
