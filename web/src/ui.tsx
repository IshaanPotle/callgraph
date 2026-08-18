/** Small shared primitives. Nothing clever — just the things every view needs. */

import type { ReactNode } from 'react';

export function Panel({
  title,
  hint,
  children,
}: {
  title?: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="panel">
      {title && (
        <h3>
          {title}
          {hint && <span className="hint">{hint}</span>}
        </h3>
      )}
      {children}
    </div>
  );
}

export function Stat({ k, v, foot, tone }: { k: string; v: string; foot?: string; tone?: string }) {
  return (
    <div className="panel stat">
      <div className="k">{k}</div>
      <div className={`v ${tone ?? ''}`}>{v}</div>
      {foot && <div className="foot">{foot}</div>}
    </div>
  );
}

export function Bar({ value, tone }: { value: number; tone?: string }) {
  return (
    <div className="bar">
      <i className={tone} style={{ width: `${Math.max(0, Math.min(1, value)) * 100}%` }} />
    </div>
  );
}

export const pct = (x: number, digits = 1) => `${(100 * x).toFixed(digits)}%`;

export const money = (x: number) => `$${x < 0.01 ? x.toFixed(4) : x.toFixed(2)}`;

/** `product_line` -> `product line`. Used anywhere a column name faces a human. */
export const humanize = (s: string) => s.replace(/[_-]+/g, ' ');

export function severityTone(s: string): string {
  return s === 'urgent' ? 'bad' : s === 'watch' ? 'warn' : '';
}
