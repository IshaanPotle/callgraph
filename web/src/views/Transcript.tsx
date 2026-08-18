import type { Transcript } from '../../../src/core/types.js';

/**
 * The raw call, with an optional span highlighted.
 *
 * Every claim in this UI terminates here. A findings page whose numbers cannot
 * be followed down to the words somebody actually said is asking to be taken on
 * faith, and the entire argument of this project is that you should not have to.
 */
export function TranscriptView({
  transcript,
  highlight,
  highlightTurn,
}: {
  transcript: Transcript;
  highlight?: string;
  highlightTurn?: number;
}) {
  return (
    <div className="transcript">
      {transcript.turns.map((turn, i) => (
        <div className="turn" key={i}>
          <span className="t">{fmt(turn.t)}</span>
          <span className={`who ${turn.speaker}`}>{turn.speaker}</span>
          <span>
            {i === highlightTurn && highlight ? mark(turn.text, highlight) : turn.text}
          </span>
        </div>
      ))}
    </div>
  );
}

function fmt(sec: number): string {
  return `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;
}

/**
 * Highlight the cited span, and quietly do nothing when it is not literally
 * there.
 *
 * That case is common and it is not a rendering bug — the extractor is allowed
 * to tidy an ASR mess out of a quote, and `quoteIsSubsequence` is how layer 3
 * tells that apart from a fabrication. The inspector reports which of those
 * happened; this just declines to draw a box around text that is not present.
 */
function mark(text: string, quote: string) {
  const at = text.toLowerCase().indexOf(quote.toLowerCase());
  if (at < 0) return text;
  return (
    <>
      {text.slice(0, at)}
      <mark>{text.slice(at, at + quote.length)}</mark>
      {text.slice(at + quote.length)}
    </>
  );
}
