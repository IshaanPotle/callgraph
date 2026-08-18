/**
 * Transcript degradation.
 *
 * Real call transcripts are not prose. They are ASR output over two people
 * talking past each other on a bad connection. Every operator here is
 * something that shows up in production transcripts, and each one is applied
 * per-call at an intensity drawn from a distribution — so the corpus contains
 * both pristine calls and calls that are barely legible, which is the only
 * honest way to test an extraction system.
 *
 * These operators are what make the eval interesting: they corrupt the exact
 * cue phrases an extractor keys on, so errors arise from a real mechanism
 * rather than from a hand-picked error rate.
 */

import type { Rng } from '../core/rng.js';
import type { Speaker, Turn } from '../core/types.js';

const FILLERS = ['um', 'uh', 'you know', 'like', 'I mean', 'sort of', 'kind of'];

/**
 * Near-miss substitutions of the kind a real ASR makes: acoustically close,
 * semantically destructive. Several of these sit on top of fact-bearing words
 * on purpose.
 */
const ASR_CONFUSIONS: [RegExp, string][] = [
  [/\bheat\b/gi, 'heap'],
  [/\bunit\b/gi, 'you and it'],
  [/\bquote\b/gi, 'coat'],
  [/\bclaim\b/gi, 'clam'],
  [/\brenewal\b/gi, 'renew all'],
  [/\bseats\b/gi, 'seeds'],
  [/\bdeductible\b/gi, 'deductable'],
  [/\binvoice\b/gi, 'in voice'],
  [/\bcancel\b/gi, 'can sell'],
  [/\bescalate\b/gi, 'escape late'],
  [/\bpolicy\b/gi, 'police he'],
  [/\bfurnace\b/gi, 'for nice'],
  [/\bwarranty\b/gi, 'warrant tea'],
  [/\badjuster\b/gi, 'add juster'],
  [/\bmanager\b/gi, 'man ager'],
  [/\bsupervisor\b/gi, 'super visor'],
  [/\brecorded\b/gi, 're corded'],
  [/\bcoverage\b/gi, 'covered age'],
  [/\bsettlement\b/gi, 'settle mint'],
  [/\bcompressor\b/gi, 'come pressor'],
  [/\bintegration\b/gi, 'in the gration'],
  [/\bsupport\b/gi, 'sub port'],
];

const INTERJECTIONS = ['mm-hm', 'right', 'okay', 'sure', 'yep', 'sorry—'];

const AMBIENT = [
  '[inaudible]',
  '[crosstalk]',
  '[background noise]',
  '[static]',
  '[unintelligible]',
];

export interface NoiseProfile {
  /** 0 = clean, 1 = barely legible. */
  level: number;
  filler: number;
  stutter: number;
  selfCorrect: number;
  asrSwap: number;
  dropout: number;
  interrupt: number;
  crosstalk: number;
  mislabel: number;
}

/**
 * Most calls are moderately messy; a long tail is very bad. Beta-ish shape,
 * approximated by averaging two uniforms and stretching — good enough, and
 * deterministic.
 */
export function drawNoiseProfile(rng: Rng): NoiseProfile {
  const raw = (rng.next() + rng.next()) / 2;
  const level = 0.06 + raw * raw * 0.62;
  return {
    level,
    filler: Math.min(0.85, level * 1.5),
    stutter: level * 0.55,
    selfCorrect: level * 0.35,
    asrSwap: level * 0.75,
    dropout: level * 0.45,
    interrupt: level * 0.6,
    crosstalk: level * 0.3,
    mislabel: level * 0.12,
  };
}

/** The ASR's own reported confidence. Correlated with true noise, not equal. */
export function reportedAsrConfidence(rng: Rng, p: NoiseProfile): number {
  const jitter = rng.float(-0.08, 0.08);
  return clamp(1 - p.level * 0.85 + jitter, 0.42, 0.99);
}

export function degrade(turns: Turn[], p: NoiseProfile, rng: Rng): Turn[] {
  let out = turns.map((t) => ({ ...t }));

  out = out.map((turn) => {
    // IVR is a recording. It doesn't stutter, and it doesn't say "um".
    // ASR still mangles it, so dropout and confusion stay in play.
    if (turn.speaker === 'IVR') {
      let ivr = turn.text;
      if (rng.bool(p.asrSwap)) ivr = asrSwap(ivr, rng);
      if (rng.bool(p.dropout * 0.5)) ivr = dropout(ivr, rng);
      return { ...turn, text: ivr };
    }

    let text = turn.text;
    if (rng.bool(p.filler)) text = injectFiller(text, rng);
    if (rng.bool(p.stutter)) text = stutter(text, rng);
    if (rng.bool(p.selfCorrect)) text = selfCorrect(text, rng);
    if (rng.bool(p.asrSwap)) text = asrSwap(text, rng);
    if (rng.bool(p.dropout)) text = dropout(text, rng);
    return { ...turn, text };
  });

  out = applyInterrupts(out, p, rng);
  out = applyCrosstalk(out, p, rng);
  out = applyMislabels(out, p, rng);

  return out.filter((t) => t.text.trim().length > 0);
}

// ---------------------------------------------------------------------------

function injectFiller(text: string, rng: Rng): string {
  const words = text.split(' ');
  if (words.length < 4) return text;
  const n = rng.int(1, 2);
  for (let i = 0; i < n; i++) {
    const at = rng.int(1, words.length - 1);
    words.splice(at, 0, rng.pick(FILLERS));
  }
  return words.join(' ');
}

function stutter(text: string, rng: Rng): string {
  const words = text.split(' ');
  if (words.length < 3) return text;
  const at = rng.int(0, words.length - 2);
  const w = words[at]!;
  if (w.length < 3) return text;
  // Either a whole-word repeat or a false start on the first syllable.
  const repeat = rng.bool(0.5) ? `${w}— ${w}` : `${w.slice(0, rng.int(1, 3))}— ${w}`;
  words[at] = repeat;
  return words.join(' ');
}

/** A wrong number, caught and corrected — the classic transcript trap. */
function selfCorrect(text: string, rng: Rng): string {
  const match = text.match(/\b\d[\d,]*\b/);
  if (!match) return text;
  const real = match[0];
  const wrong = String(rng.int(2, 9)) + real.slice(1);
  return text.replace(real, `${wrong}— no sorry, ${real}`);
}

function asrSwap(text: string, rng: Rng): string {
  const applicable = ASR_CONFUSIONS.filter(([re]) => {
    re.lastIndex = 0;
    return re.test(text);
  });
  if (applicable.length === 0) return text;
  const [re, replacement] = rng.pick(applicable);
  re.lastIndex = 0;
  // Swap one occurrence, not all — ASR is inconsistent, which is worse.
  let done = false;
  return text.replace(re, (m) => {
    if (done) return m;
    done = true;
    return replacement;
  });
}

function dropout(text: string, rng: Rng): string {
  const words = text.split(' ');
  if (words.length < 5) return text;
  const at = rng.int(1, words.length - 2);
  const span = rng.int(1, 2);
  words.splice(at, span, rng.pick(AMBIENT));
  return words.join(' ');
}

/** Cut a turn mid-sentence, drop a short interjection in, resume with a dash. */
function applyInterrupts(turns: Turn[], p: NoiseProfile, rng: Rng): Turn[] {
  const out: Turn[] = [];
  for (const turn of turns) {
    const words = turn.text.split(' ');
    if (turn.speaker !== 'IVR' && words.length >= 8 && rng.bool(p.interrupt)) {
      const at = rng.int(3, words.length - 3);
      const other: Speaker = turn.speaker === 'AGENT' ? 'CUSTOMER' : 'AGENT';
      out.push({ ...turn, text: `${words.slice(0, at).join(' ')}—` });
      out.push({ t: turn.t + 1, speaker: other, text: rng.pick(INTERJECTIONS) });
      out.push({ t: turn.t + 2, speaker: turn.speaker, text: `—${words.slice(at).join(' ')}` });
    } else {
      out.push(turn);
    }
  }
  return out;
}

/** Two people talking at once collapses into one unattributable turn. */
function applyCrosstalk(turns: Turn[], p: NoiseProfile, rng: Rng): Turn[] {
  const out: Turn[] = [];
  for (let i = 0; i < turns.length; i++) {
    const a = turns[i]!;
    const b = turns[i + 1];
    if (b && a.speaker !== b.speaker && rng.bool(p.crosstalk)) {
      out.push({ t: a.t, speaker: 'UNKNOWN', text: `${a.text} [crosstalk] ${b.text}` });
      i++;
    } else {
      out.push(a);
    }
  }
  return out;
}

/** Diarization is not perfect. Sometimes the wrong name is on the line. */
function applyMislabels(turns: Turn[], p: NoiseProfile, rng: Rng): Turn[] {
  return turns.map((t) => {
    if (t.speaker === 'UNKNOWN' || t.speaker === 'IVR') return t;
    if (!rng.bool(p.mislabel)) return t;
    return { ...t, speaker: t.speaker === 'AGENT' ? 'CUSTOMER' : 'AGENT' };
  });
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}
