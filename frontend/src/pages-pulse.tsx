import { useEffect, useState } from 'react';
import { Activity, Database, Gauge, Timer } from 'lucide-react';
import { ErrorNotice, Loading, PageHeading, Tag } from './components';
import { money } from './api';
import { useResource } from './hooks';
import { FunnelBars, LineChart } from './charts';
import type { PulseDTO } from './contracts';

const bytes = (value: number) => value >= 1e6 ? `${(value / 1e6).toFixed(1)} MB` : value >= 1e3 ? `${Math.round(value / 1e3)} kB` : `${value} B`;
const title = (value: string) => value.replace(/\b\w/g, c => c.toUpperCase());

function Stat({ icon: Icon, label, value, note }: { icon: typeof Activity; label: string; value: string; note?: string }) {
  return <section className="panel stat-tile"><span className="stat-label"><Icon size={15} />{label}</span><strong className="stat-value">{value}</strong>{note && <span className="stat-note">{note}</span>}</section>;
}

/** Public, anonymous view of what Accord observes: live market prices and how groups reach consensus. Served from Tiger Data. */
export function Pulse() {
  const [tick, setTick] = useState(0);
  useEffect(() => { const timer = setInterval(() => setTick(t => t + 1), 15_000); return () => clearInterval(timer); }, []);
  const resource = useResource<PulseDTO>('/pulse', tick);
  const data = resource.data;
  return <div className="page pulse-page">
    <PageHeading eyebrow="Powered by Tiger Data" title="The market, and the moment a group agrees." description="Every live price Accord sees and every step toward consensus, stored as time-series in Tiger Data. Public listing prices and anonymous events only: no names, budgets or requirements ever leave Accord." aside={<Tag>Refreshes every 15s</Tag>} />
    {resource.loading && !data && <Loading />}
    <ErrorNotice error={resource.error} retry={resource.refresh} />
    {data && <>
      <div className="stat-grid">
        <Stat icon={Activity} label="Price observations" value={data.totals.observations.toLocaleString('en-US')} note={`${data.totals.listings.toLocaleString('en-US')} listings · ${data.totals.destinations} destinations`} />
        <Stat icon={Database} label="Compression" value={data.storage.ratio !== undefined ? `${Math.round(data.storage.ratio * 100)}% smaller` : 'Pending'}
          note={data.storage.ratio !== undefined ? `${bytes(data.storage.beforeBytes)} → ${bytes(data.storage.afterBytes)} · ${data.storage.compressedChunks}/${data.storage.chunks} chunks` : `Hourly chunks compress after 2 hours · ${bytes(data.storage.totalBytes)} stored`} />
        <Stat icon={Timer} label="Stale detection" value={data.consensus.medianStaleDetectionMs !== undefined ? `${Math.round(data.consensus.medianStaleDetectionMs)} ms` : '—'} note="Median, live price check → approvals voided" />
        <Stat icon={Gauge} label="Dashboard query" value={`${data.queryMs} ms`} note="All panels, one round of Tiger queries" />
      </div>
      <section className="panel">
        <div className="section-heading"><h2>Average nightly price, last 24 hours</h2><span className="eyebrow">Continuous aggregate · 5-min buckets</span></div>
        <LineChart label="Average nightly price by destination over the last 24 hours" format={value => money(value)}
          series={data.markets.map(market => ({ name: title(market.destination), points: market.points.map(point => ({ at: point.at, value: point.nightlyCents })) }))} />
      </section>
      <div className="room-grid">
        <section className="panel">
          <div className="section-heading"><h2>How groups reach a yes</h2><span className="eyebrow">Last 7 days</span></div>
          <FunnelBars steps={[{ label: 'Proposals', value: data.consensus.proposals }, { label: 'Everyone approved', value: data.consensus.ready }, { label: 'Booked or handed off', value: data.consensus.booked }]} />
          <dl className="boundary-list">
            <div><dt>Median time to everyone approving</dt><dd>{data.consensus.medianMinutesToReady !== undefined ? `${data.consensus.medianMinutesToReady.toFixed(1)} min` : '—'}</dd></div>
            <div><dt>Proposals invalidated by a change</dt><dd>{data.consensus.stale}</dd></div>
            <div><dt>Median change → new proposal</dt><dd>{data.consensus.medianSecondsStaleToReplan !== undefined ? `${Math.round(data.consensus.medianSecondsStaleToReplan)} s` : '—'}</dd></div>
          </dl>
        </section>
        <section className="panel">
          <div className="section-heading"><h2>Prices that moved</h2><span className="eyebrow">Last 24 hours</span></div>
          {data.movers.length === 0 ? <p className="subtle">No price changes observed yet. Accord re-checks an open proposal's price every two minutes.</p>
            : <div className="matrix-scroll"><table className="movers"><thead><tr><th scope="col">Listing</th><th scope="col">Changes</th><th scope="col">Range</th><th scope="col">Now</th></tr></thead>
              <tbody>{data.movers.map(mover => <tr key={mover.offerId}><th scope="row">{mover.propertyName}<small>{title(mover.destination)}</small></th><td>{mover.changes}</td><td>{money(mover.minCents)}–{money(mover.maxCents)}</td><td>{money(mover.latestCents)}</td></tr>)}</tbody></table></div>}
          <p className="fine">Totals are for the whole stay. Providers: {Object.entries(data.totals.byProvider).map(([name, count]) => `${name === 'LITEAPI' ? 'LiteAPI' : 'Google Hotels'} ${count.toLocaleString('en-US')}`).join(' · ') || 'none yet'}.</p>
        </section>
      </div>
    </>}
  </div>;
}
