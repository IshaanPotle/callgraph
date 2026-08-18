import { Tracer } from '../trace.js';
import type { FaultInjector } from '../../sim/faults.js';
import { AnthropicProvider } from './anthropic.js';
import type { Effort, LlmProvider } from './provider.js';
import { StubProvider } from './stub.js';

export * from './provider.js';
export { AnthropicProvider } from './anthropic.js';
export { StubProvider, estimateTokens } from './stub.js';
export { FaultInjector } from '../../sim/faults.js';
export type { InjectedFault, FaultKind } from '../../sim/faults.js';

export interface ProviderConfig {
  provider: 'anthropic' | 'stub';
  model: string;
  effort: Effort;
  concurrency: number;
}

const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/**
 * Resolution order: explicit `LLM_PROVIDER`, else live if a key exists, else
 * the simulator. The default is chosen so a fresh clone never fails with an
 * auth error — it just runs offline and says so.
 */
export function resolveConfig(env: NodeJS.ProcessEnv = process.env): ProviderConfig {
  const explicit = env.LLM_PROVIDER?.trim().toLowerCase();
  const hasKey = Boolean(env.ANTHROPIC_API_KEY?.trim());

  let provider: 'anthropic' | 'stub';
  if (explicit === 'anthropic' || explicit === 'stub') provider = explicit;
  else provider = hasKey ? 'anthropic' : 'stub';

  if (provider === 'anthropic' && !hasKey) {
    throw new Error('LLM_PROVIDER=anthropic but ANTHROPIC_API_KEY is not set.');
  }

  const effortRaw = env.CALLGRAPH_EFFORT?.trim().toLowerCase() as Effort | undefined;
  const effort = effortRaw && EFFORTS.includes(effortRaw) ? effortRaw : 'high';

  const concurrency = Number.parseInt(env.CALLGRAPH_CONCURRENCY ?? '', 10);

  return {
    provider,
    model: env.CALLGRAPH_MODEL?.trim() || 'claude-opus-5',
    effort,
    concurrency: Number.isFinite(concurrency) && concurrency > 0 ? concurrency : 8,
  };
}

/**
 * `faults` is accepted but only ever reaches the simulator, and that asymmetry
 * is deliberate rather than an oversight: injecting errors into real model
 * output would measure nothing, since the real error rate is already unknown
 * and adding a known quantity to an unknown one leaves it unknown.
 */
export function createProvider(
  config: ProviderConfig,
  tracer: Tracer,
  faults?: FaultInjector,
): LlmProvider {
  return config.provider === 'anthropic'
    ? new AnthropicProvider({ model: config.model, tracer, defaultEffort: config.effort })
    : new StubProvider({ model: config.model, tracer, faults });
}
