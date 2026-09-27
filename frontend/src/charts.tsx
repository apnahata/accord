import { useId, useMemo, useState, type PointerEvent, type ReactNode } from 'react';
import { Radar } from 'lucide-react';

// Categorical slots (fixed order, validated for CVD + contrast on the #fffefa panel surface). Text never uses these.
export const SERIES = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100'];
const time = (at: string) => new Date(at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

/** A chart's empty state should explain what will appear and why — never a bare gray sentence that reads as a rendering failure. */
export function ChartEmpty({ icon: Icon = Radar, title, children }: { icon?: typeof Radar; title: string; children: ReactNode }) {
  return <div className="empty chart-empty"><span className="icon-circle"><Icon size={20} /></span><h3>{title}</h3><p>{children}</p></div>;
}

/** Tiny single-series price line for an offer card. Hover a point for its value. */
export function Sparkline({ points, format }: { points: Array<{ at: string; value: number }>; format: (value: number) => string }) {
  const [hover, setHover] = useState<number>();
  if (points.length < 2) return null;
  const w = 120, h = 28, pad = 4;
  const min = Math.min(...points.map(p => p.value)), max = Math.max(...points.map(p => p.value));
  const x = (i: number) => pad + (i / (points.length - 1)) * (w - pad * 2);
  const y = (v: number) => max === min ? h / 2 : h - pad - ((v - min) / (max - min)) * (h - pad * 2);
  const last = points.length - 1, shown = hover ?? last;
  return <span className="sparkline">
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} role="img" aria-label={`Price over the last ${points.length} observations, from ${format(points[0]!.value)} to ${format(points[last]!.value)}`}
      onPointerLeave={() => setHover(undefined)}
      onPointerMove={(event: PointerEvent<SVGSVGElement>) => { const box = event.currentTarget.getBoundingClientRect(); setHover(Math.round(((event.clientX - box.left) / box.width * w - pad) / (w - pad * 2) * last)); }}>
      <polyline points={points.map((p, i) => `${x(i)},${y(p.value)}`).join(' ')} fill="none" stroke="var(--green)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={x(Math.max(0, Math.min(last, shown)))} cy={y(points[Math.max(0, Math.min(last, shown))]!.value)} r={4} fill="var(--green)" stroke="#fffefa" strokeWidth={2} />
    </svg>
    <small>{time(points[Math.max(0, Math.min(last, shown))]!.at)} · {format(points[Math.max(0, Math.min(last, shown))]!.value)}</small>
  </span>;
}

export type Series = { name: string; points: Array<{ at: string; value: number }> };

/** Multi-series time line chart: one y-axis, legend + end labels, crosshair tooltip, table view. */
export function LineChart({ series, format, label }: { series: Series[]; format: (value: number) => string; label: string }) {
  const id = useId();
  const [hoverAt, setHoverAt] = useState<number>();
  const [table, setTable] = useState(false);
  const w = 640, h = 240, left = 56, right = 110, top = 12, bottom = 26;
  const all = series.flatMap(s => s.points);
  const layout = useMemo(() => {
    if (!all.length) return undefined;
    const times = all.map(p => Date.parse(p.at)), values = all.map(p => p.value);
    const t0 = Math.min(...times), t1 = Math.max(...times);
    const step = niceStep((Math.max(...values) - Math.min(...values)) || Math.max(...values) || 1);
    const v0 = Math.floor(Math.min(...values) / step) * step, v1 = Math.ceil(Math.max(...values) / step) * step || step;
    return { t0, t1: t1 === t0 ? t0 + 1 : t1, v0, v1: v1 === v0 ? v0 + step : v1, step };
  }, [all]);
  if (!layout) return <figure className="chart"><figcaption className="sr-only">{label}</figcaption>
    <ChartEmpty title="Recording starts the moment a price is checked.">Every price a provider returns is written to Tiger Data immediately. This line fills in as soon as the first live search runs — nothing to configure, nothing broken.</ChartEmpty>
  </figure>;
  const x = (at: string) => left + ((Date.parse(at) - layout.t0) / (layout.t1 - layout.t0)) * (w - left - right);
  const y = (v: number) => top + (1 - (v - layout.v0) / (layout.v1 - layout.v0)) * (h - top - bottom);
  const ticks: number[] = []; for (let v = layout.v0; v <= layout.v1 + 1e-9; v += layout.step) ticks.push(v);
  const nearest = (s: Series) => hoverAt === undefined ? undefined : s.points.reduce((best, p) => Math.abs(Date.parse(p.at) - hoverAt) < Math.abs(Date.parse(best.at) - hoverAt) ? p : best, s.points[0]!);
  return <figure className="chart" aria-labelledby={`${id}-cap`}>
    <figcaption id={`${id}-cap`} className="sr-only">{label}</figcaption>
    <div className="chart-legend">{series.map((s, i) => <span key={s.name}><i style={{ background: SERIES[i % SERIES.length] }} />{s.name}</span>)}
      <button className="text-button" onClick={() => setTable(!table)} aria-pressed={table}>{table ? 'Show chart' : 'Show table'}</button></div>
    {table ? <div className="matrix-scroll"><table><thead><tr><th scope="col">Time</th>{series.map(s => <th scope="col" key={s.name}>{s.name}</th>)}</tr></thead>
      <tbody>{[...new Set(all.map(p => p.at))].sort().map(at => <tr key={at}><th scope="row">{time(at)}</th>{series.map(s => { const p = s.points.find(q => q.at === at); return <td key={s.name}>{p ? format(p.value) : '—'}</td>; })}</tr>)}</tbody></table></div>
    : <div className="chart-wrap">
      <svg viewBox={`0 0 ${w} ${h}`} role="img" aria-label={label} className="chart-svg"
        onPointerLeave={() => setHoverAt(undefined)}
        onPointerMove={(event: PointerEvent<SVGSVGElement>) => { const box = event.currentTarget.getBoundingClientRect(); const px = (event.clientX - box.left) / box.width * w;
          setHoverAt(layout.t0 + Math.max(0, Math.min(1, (px - left) / (w - left - right))) * (layout.t1 - layout.t0)); }}>
        {ticks.map(v => <g key={v}><line x1={left} x2={w - right} y1={y(v)} y2={y(v)} className="chart-grid" /><text x={left - 8} y={y(v) + 4} textAnchor="end" className="chart-tick">{format(v)}</text></g>)}
        <text x={left} y={h - 6} className="chart-tick">{time(new Date(layout.t0).toISOString())}</text>
        <text x={w - right} y={h - 6} textAnchor="end" className="chart-tick">{time(new Date(layout.t1).toISOString())}</text>
        {series.map((s, i) => { const color = SERIES[i % SERIES.length], end = s.points[s.points.length - 1]!;
          return <g key={s.name}>
            <polyline points={s.points.map(p => `${x(p.at)},${y(p.value)}`).join(' ')} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
            <circle cx={x(end.at)} cy={y(end.value)} r={4} fill={color} stroke="#fffefa" strokeWidth={2} />
            <text x={x(end.at) + 8} y={y(end.value) + 4} className="chart-label">{s.name.length > 14 ? `${s.name.slice(0, 13)}…` : s.name}</text>
          </g>; })}
        {hoverAt !== undefined && <line x1={x(new Date(hoverAt).toISOString())} x2={x(new Date(hoverAt).toISOString())} y1={top} y2={h - bottom} className="chart-crosshair" />}
        {hoverAt !== undefined && series.map((s, i) => { const p = nearest(s); return p && <circle key={s.name} cx={x(p.at)} cy={y(p.value)} r={4} fill={SERIES[i % SERIES.length]} stroke="#fffefa" strokeWidth={2} />; })}
      </svg>
      {hoverAt !== undefined && <div className="chart-tooltip" style={{ left: `${(x(new Date(hoverAt).toISOString()) / w) * 100}%` }}>
        <strong>{time(new Date(hoverAt).toISOString())}</strong>
        {series.map((s, i) => { const p = nearest(s); return p && <span key={s.name}><i style={{ background: SERIES[i % SERIES.length] }} />{s.name}: {format(p.value)}</span>; })}
      </div>}
    </div>}
  </figure>;
}

/** Horizontal bars for a small ordered funnel (single hue, labels at the tip). */
export function FunnelBars({ steps, emptyTitle, children }: { steps: Array<{ label: string; value: number }>; emptyTitle?: string; children?: ReactNode }) {
  if (steps.every(step => step.value === 0)) return <ChartEmpty title={emptyTitle ?? 'No activity in this window yet.'}>{children ?? 'Each stage records the moment it happens — this fills in as soon as the first group moves through it.'}</ChartEmpty>;
  const max = Math.max(1, ...steps.map(s => s.value));
  return <ol className="funnel-bars">{steps.map(step => <li key={step.label} title={`${step.label}: ${step.value}`}>
    <span className="funnel-label">{step.label}</span>
    <span className="funnel-track"><span className="funnel-bar" style={{ width: `${Math.max(2, (step.value / max) * 100)}%` }} /></span>
    <strong>{step.value.toLocaleString('en-US')}</strong>
  </li>)}</ol>;
}

function niceStep(range: number) {
  const raw = range / 4, power = 10 ** Math.floor(Math.log10(raw)), unit = raw / power;
  return (unit <= 1 ? 1 : unit <= 2 ? 2 : unit <= 5 ? 5 : 10) * power;
}
