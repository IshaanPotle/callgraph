/**
 * The provider seam.
 *
 * Every agent in this system talks to exactly one interface. Two things
 * implement it:
 *
 *   - `AnthropicProvider` — real calls to Claude.
 *   - `StubProvider`      — a deterministic offline simulator.
 *
 * The simulator is not a mock in the testing sense. It is a second
 * implementation of the same contract that lets the entire pipeline, the
 * critic, the eval harness, and the UI run end-to-end with no API key and no
 * network — which is how this repo can be cloned and produce numbers in ten
 * seconds. Artifacts are stamped with which provider produced them, and the
 * UI says so on every page.
 */

import type { z } from 'zod';

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface GenerateRequest<T> {
  /** Dotted agent name — becomes the trace span's `agent`. */
  agent: string;
  callId?: string;
  /**
   * Stable across every call this agent makes. Kept byte-identical on purpose:
   * it is the cached prefix, and any variation in it silently kills the cache.
   */
  system: string;
  /** The volatile part — one call's transcript, one batch of proposals. */
  user: string;
  schema: z.ZodType<T>;
  effort?: Effort;
  maxTokens?: number;
  /**
   * Deterministic offline answer for this exact request.
   *
   * The live provider never calls it. The simulator calls only this. Keeping
   * it at the call site means the offline behaviour of an agent lives next to
   * the agent, and there is exactly one orchestration path either way.
   */
  simulate: () => T;
}

export interface LlmProvider {
  readonly kind: 'anthropic' | 'stub';
  readonly model: string;
  generate<T>(req: GenerateRequest<T>): Promise<T>;
}

/** Raised when a response cannot be coerced into the requested schema. */
export class SchemaViolation extends Error {
  constructor(
    readonly agent: string,
    readonly detail: string,
  ) {
    super(`${agent}: response did not match schema — ${detail}`);
    this.name = 'SchemaViolation';
  }
}

/** Raised when the model declines. Surfaced, never silently swallowed. */
export class ModelRefusal extends Error {
  constructor(
    readonly agent: string,
    readonly category: string | null,
  ) {
    super(`${agent}: model refused (category=${category ?? 'unknown'})`);
    this.name = 'ModelRefusal';
  }
}
