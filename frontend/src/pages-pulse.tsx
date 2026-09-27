import { useEffect, useState } from 'react';
import { Activity, Database, Gauge, Timer } from 'lucide-react';
import { ErrorNotice, Loading, PageHeading, Tag } from './components';
import { money } from './api';
import { useResource } from './hooks';
import { ChartEmpty, FunnelBars, LineChart } from './charts';
import type { PulseDTO } from './contracts';

const bytes = (value: number) => value >= 1e6 ? `${(value / 1e6).toFixed(1)} MB` : value >= 1e3 ? `${Math.round(value / 1e3)} kB` : `${value} B`;
const title = (value: string) => value.replace(/\b\w/g, c => c.toUpperCase());

function Stat({ icon: Icon, label, value, note, tone }: { icon: typeof Activity; label: string; value: string; note?: string; tone?: 'warm' }) {
  return <section className="panel stat-tile"><span className="stat-label"><Icon size={15} />{label}</span><strong className="stat-value">{value}</strong>{note && (tone === 'warm' ? <Tag tone="warm">{note}</Tag> : <span className="stat-note">{note}</span>)}</section>;
}

/** Public, anonymous view of what Accord observes: live market prices and how groups reach consensus. Served from Tiger Data. */
export function Pulse() {
  const [tick, setTick] = useState(0);
  useEffect(() => { const timer = setInterval(() => setTick(t => t + 1), 15_000); return () => clearInterval(timer); }, []);
  const resource = useResource<PulseDTO>('/pulse', tick);
  const data = resource.data;
  return <div className="page pulse-page">
    <PageHeading eyebrow="Powered by Tiger Data" title="The market, and the moment a group agrees." description="Every live price Accord sees and every step toward consensus, stored as time-series in Tiger Data. This is the same record that catches a merchant repricing after a group has already agreed. Public listing prices and anonymous events only: no names, budgets or requirements ever leave Accord." aside={<Tag>Refreshes every 15s</Tag>} />
    {resource.loading && !data && <Loading />}
    <ErrorNotice error={resource.error} retry={resource.refresh} />
    {data && <>
      <div className="stat-grid">
        <Stat icon={Activity} label="Price observations" value={data.totals.observations.toLocaleString('en-US')} note={`${data.totals.listings.toLocaleString('en-US')} listings · ${data.totals.destinations} destinations`} />
        <Stat icon={Database} label="Compression" value={data.storage.ratio !== undefined ? `${Math.round(data.storage.ratio * 100)}% smaller` : 'Pending'} tone={data.storage.ratio === undefined ? 'warm' : undefined}
          note={data.storage.ratio !== undefined ? `${bytes(data.storage.beforeBytes)} → ${bytes(data.storage.afterBytes)} · ${data.storage.compressedChunks}/${data.storage.chunks} chunks` : `Expected for ~2 hours after the first chunk — Timescale compresses on a schedule, not on demand · ${bytes(data.storage.totalBytes)} stored so far`} />
        <Stat icon={Timer} label="Stale detection" value={data.consensus.medianStaleDetectionMs !== undefined ? `${Math.round(data.consensus.medianStaleDetectionMs)} ms` : '—'} note="Median time from a live price check to voiding stale approvals" />
        <Stat icon={Gauge} label="Dashboard query" value={`${data.queryMs} ms`} note="All four panels above, one round of Tiger queries" />
      </div>
      <section className="panel">
        <div className="section-heading"><h2>The prices Accord is watching, live</h2><span className="eyebrow">Continuous aggregate · 5-min buckets</span></div>
        <p className="subtle">This is the exact feed that catches a price move after a group has already signed off — the mechanism behind every stale-proposal notice.</p>
        <LineChart label="Average nightly price by destination over the last 24 hours" format={value => money(value)}
          series={data.markets.map(market => ({ name: title(market.destination), points: market.points.map(point => ({ at: point.at, value: point.nightlyCents })) }))} />
      </section>
      <div className="room-grid">
        <section className="panel">
          <div className="section-heading"><h2>How groups reach a yes</h2><span className="eyebrow">Last 7 days</span></div>
          <p className="subtle">Every proposal Accord has ever offered a group, tracked to the moment everyone approved or the plan moved on.</p>
          <FunnelBars emptyTitle="No proposals in the last 7 days yet." steps={[{ label: 'Proposals', value: data.consensus.proposals }, { label: 'Everyone approved', value: data.consensus.ready }, { label: 'Booked or handed off', value: data.consensus.booked }]}>
            This funnel fills in as groups get a proposal, approve it, and book — each step timestamped the moment it happens.
          </FunnelBars>
          <dl className="boundary-list">
            <div><dt>Median time to everyone approving</dt><dd>{data.consensus.medianMinutesToReady !== undefined ? `${data.consensus.medianMinutesToReady.toFixed(1)} min` : '—'}</dd></div>
            <div><dt>Proposals invalidated by a change</dt><dd>{data.consensus.stale}</dd></div>
            <div><dt>Median change → new proposal</dt><dd>{data.consensus.medianSecondsStaleToReplan !== undefined ? `${Math.round(data.consensus.medianSecondsStaleToReplan)} s` : '—'}</dd></div>
          </dl>
        </section>
        <section className="panel">
          <div className="section-heading"><h2>Proof a stale price gets caught</h2><span className="eyebrow">Last 24 hours</span></div>
          {data.movers.length === 0 ? <ChartEmpty title="No price changes in the last 24 hours.">Accord re-checks a proposal's price every two minutes. When a provider changes a price, it lands here the moment it's recorded — and any affected proposal is voided automatically.</ChartEmpty>
            : <div className="matrix-scroll"><table className="movers"><thead><tr><th scope="col">Listing</th><th scope="col">Changes</th><th scope="col">Range</th><th scope="col">Now</th></tr></thead>
              <tbody>{data.movers.map(mover => <tr key={mover.offerId}><th scope="row">{mover.propertyName}<small>{title(mover.destination)}</small></th><td>{mover.changes}</td><td>{money(mover.minCents)}–{money(mover.maxCents)}</td><td>{money(mover.latestCents)}</td></tr>)}</tbody></table></div>}
          <p className="fine">Totals are for the whole stay. Providers: {Object.entries(data.totals.byProvider).map(([name, count]) => `${name === 'LITEAPI' ? 'LiteAPI' : 'Google Hotels'} ${count.toLocaleString('en-US')}`).join(' · ') || 'none yet'}.</p>
        </section>
      </div>
    </>}
  </div>;
}
