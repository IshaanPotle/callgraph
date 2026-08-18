/**
 * Writes the corpus to disk for inspection. The pipeline does not read these
 * files — it regenerates from the seed, which is why the corpus is gitignored
 * and the seed is not.
 */

import { mkdirSync, writeFileSync } from 'node:fs';

import { CONFIG } from '../config.js';
import { generateCorpus, renderTranscript } from '../corpus/generate.js';

const calls = generateCorpus(CONFIG.corpus);

mkdirSync('data/corpus', { recursive: true });
writeFileSync(
  'data/corpus/transcripts.json',
  JSON.stringify(calls.map((c) => c.transcript), null, 2),
);
writeFileSync('data/corpus/facts.json', JSON.stringify(calls.map((c) => c.facts), null, 2));

// A readable sample, because JSON of a transcript is unreadable and you will
// want to actually look at these.
const sample = calls
  .slice(0, 6)
  .map((c) => `${renderTranscript(c.transcript)}\n\n--- latent facts ---\n${JSON.stringify(c.facts, null, 2)}`)
  .join('\n\n========================================\n\n');
writeFileSync('data/corpus/sample.txt', sample);

const byVertical = new Map<string, number>();
for (const c of calls) byVertical.set(c.facts.vertical, (byVertical.get(c.facts.vertical) ?? 0) + 1);

const avgTurns = calls.reduce((s, c) => s + c.transcript.turns.length, 0) / calls.length;
const avgAsr = calls.reduce((s, c) => s + c.transcript.asrConfidence, 0) / calls.length;

console.log(`corpus: ${calls.length} calls, seed ${CONFIG.corpus.seed}`);
console.log(`  by vertical: ${[...byVertical].map(([k, v]) => `${k}=${v}`).join(', ')}`);
console.log(`  avg turns/call: ${avgTurns.toFixed(1)}`);
console.log(`  avg ASR confidence: ${avgAsr.toFixed(3)}`);
console.log('  wrote data/corpus/{transcripts,facts}.json and sample.txt');
