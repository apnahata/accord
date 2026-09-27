import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Activity, ArrowLeft, ArrowRight, Check, CheckCheck, ChevronRight, Clock3, LockKeyhole, MapPin, RefreshCw, ShieldCheck, Sparkles, Users, Zap } from 'lucide-react';
import { Button, CheckStatus, Empty, ErrorNotice, Funding, Integrity, LinkButton, Loading, OfferCard, OfferFacts, PageHeading, PrivateNote, Stability, Stale, StayArt, Tag, Timeline } from './components';
import { api, ApiError, calendarDate, date, dateTime, money, post, segment } from './api';
import { PrivateExplanationCard, PublicExplanationCard } from './explanations';
import { useAction, useResource, useRoomEvents } from './hooks';
import { Inbox, WatchLine } from './autopilot';
import { StepCard } from './room-step';
import type { AnalyticsDTO, Capabilities, ConsentResponseDTO, EventDTO, InboxDTO, MerchantDTO, OffersDTO, PrivateProposalEnvelope, ProposalEnvelope, PublicRoomDTO, ReceiptDTO, RoomPulseDTO } from './contracts';
import type { MerchantMutation } from '@accord/domain';

function RoomNav({ roomId, active }: { roomId: string; active: 'room' | 'offers' }) { return <nav className="room-nav" aria-label="Group navigation"><Link aria-current={active === 'room' ? 'page' : undefined} to={`/rooms/${segment(roomId)}`}>Our group</Link><Link aria-current={active === 'offers' ? 'page' : undefined} to={`/rooms/${segment(roomId)}/offers`}>Explore stays</Link><Link to={`/rooms/${segment(roomId)}/me/summary`}><LockKeyhole size={14} />My private space</Link></nav>; }
function Members({ room, base, onChange }: { room: PublicRoomDTO; base: string; onChange: () => void }) {
  const action = useAction();
  const navigate = useNavigate();
  const leave = () => {
    if (!window.confirm('Leave this group? Your private requirements are deleted, and everyone else will need to re-approve with the new group size.')) return;
    void action.run(async () => { await post(`${base}/me/leave`); navigate('/'); });
  };
  const remove = (id: string, name: string) => {
    if (!window.confirm(`Remove ${name} from the group? Their invite session will stop working. You can invite them again later.`)) return;
    void action.run(async () => { await api(`${base}/members/${segment(id)}`, { method: 'DELETE' }); onChange(); });
  };
  return <section className="panel members-panel">
    <div className="section-heading"><h3>Who’s here</h3><span className="eyebrow">{room.memberCount} {room.memberCount === 1 ? 'member' : 'members'}</span></div>
    <ul className="member-list">{room.members.map(member => <li key={member.id}><span className={`member-status ${member.ready ? 'ready' : ''}`} aria-hidden="true">{member.ready ? <Check size={13} /> : null}</span><span className="member-name"><strong>{member.displayName}</strong>{member.isYou && <small> (you)</small>}{member.isHost && <small> · host</small>}<small className="member-state">{member.ready ? 'Requirements confirmed' : 'Waiting on requirements'}</small></span>{room.viewerIsHost && !member.isHost && !member.ready && <button className="text-button member-remove" disabled={action.busy} onClick={() => remove(member.id, member.displayName)}>Remove</button>}{member.isYou && !member.isHost && room.status !== 'BOOKED' && <button className="text-button member-remove" disabled={action.busy} onClick={leave}>Leave group</button>}</li>)}</ul>
    {room.viewerIsHost && <p className="fine">As host, you can remove members who haven’t confirmed their requirements yet.</p>}
    <ErrorNotice error={action.error} />
  </section>;
}
function MerchantDemoCallout({ base }: { base: string }) {
  return <section className="panel decision-invitation merchant-demo-callout">
    <Zap size={22} />
    <Tag>Host demo</Tag>
    <h3>Simulate a real-world change</h3>
    <p>See what happens when a merchant changes price or terms after everyone has approved.</p>
    <LinkButton to={`${base}/demo/merchant`}>Demo: change the offer</LinkButton>
  </section>;
}
function LiveLabel({ connection }: { connection: string }) { return <span className={`live-label ${connection === 'live' ? '' : 'offline'}`}><span />{connection === 'live' ? 'Live with your group' : connection === 'connecting' ? 'Connecting…' : 'Reconnecting · checking for updates'}</span>; }

/** Contextual, real-data link to the public market dashboard — hidden whenever Tiger is unconfigured or there's nothing yet worth surfacing. */
function MarketPulseCallout({ room, base }: { room: PublicRoomDTO; base: string }) {
  const capabilities = useResource<Capabilities>('/capabilities');
  const tigerAvailable = capabilities.data?.tiger.available === true;
  const roomPulse = useResource<RoomPulseDTO>(tigerAvailable && room.trip ? `${base}/pulse` : null);
  if (!tigerAvailable || !room.trip || !roomPulse.data || roomPulse.data.observations === 0) return null;
  return <section className="panel pulse-callout">
    <Activity size={20} />
    <h3>Nobody can quietly reprice this trip.</h3>
    <p>Accord has checked <strong>{roomPulse.data.observations.toLocaleString('en-US')}</strong> live {roomPulse.data.observations === 1 ? 'price' : 'prices'} across {roomPulse.data.listings.toLocaleString('en-US')} {roomPulse.data.listings === 1 ? 'listing' : 'listings'} for your group’s exact dates and guest count, timestamped in Tiger Data — the same record Accord uses to void a proposal the moment a price moves.</p>
    <Link to="/pulse" className="text-button">See the live market <ArrowRight size={15} /></Link>
  </section>;
}

export function Room() {
  const { roomId = '' } = useParams();
  const base = `/rooms/${segment(roomId)}`;
  const live = useRoomEvents(roomId);
  const room = useResource<PublicRoomDTO>(base, live.revision);
  const proposal = useResource<ProposalEnvelope>(room.data?.activeProposalId ? `/proposals/${segment(room.data.activeProposalId)}/public` : null, live.revision);
  const personal = useResource<PrivateProposalEnvelope>(room.data?.activeProposalId ? `/proposals/${segment(room.data.activeProposalId)}/me` : null, live.revision);
  const inbox = useResource<InboxDTO>(`${base}/me/inbox`, live.revision);
  const nudge = inbox.data?.messages.find(message => message.kind === 'NUDGE' && message.nudge?.status === 'OPEN');
  const refresh = () => { room.refresh(); inbox.refresh(); personal.refresh(); };
  return <div className="page step-room">
    {room.loading && !room.data && <Loading />}
    <ErrorNotice error={room.error} retry={room.refresh} />
    {room.data && <>
      <header className="step-head">
        <h1>{room.data.name}</h1>
        <p className="lead">{room.data.members.map(member => member.displayName).join(' · ')}</p>
      </header>
      <StepCard room={room.data} base={base} proposal={proposal.data} personal={personal.data} nudge={nudge} onChange={refresh} />
      <ErrorNotice error={proposal.error} retry={proposal.refresh} />
      <div className="step-extras">
        {room.data.viewerIsHost && <MerchantDemoCallout base={base} />}
        <MarketPulseCallout room={room.data} base={base} />
      </div>
    </>}
  </div>;
}

export function Offers() {
  const { roomId = '' } = useParams();
  const live = useRoomEvents(roomId);
  const resource = useResource<OffersDTO>(`/rooms/${segment(roomId)}/offers`, live.revision);
  const action = useAction();
  const [filter, setFilter] = useState<'all' | 'feasible'>('all');
  const [view, setView] = useState<'stays' | 'understanding'>('stays');
  const data = resource.data;
  return <div className="page"><RoomNav roomId={roomId} active="offers" /><PageHeading eyebrow="Different needs. Shared possibilities." title="Somewhere that works for everyone." description="Every stay is checked against the group’s confirmed requirements. The details behind those requirements stay private." aside={<LiveLabel connection={live.connection} />} />{resource.loading && !data && <Loading />}<ErrorNotice error={resource.error} retry={resource.refresh} /><ErrorNotice error={action.error} />{data && <><p className="inventory-label">{data.inventoryLabel}</p>{data.providerResults.some(provider => provider.status === 'FAILED') && <div className="notice"><div><strong>A live provider could not complete the last search.</strong><p>{data.providerResults.filter(provider => provider.status === 'FAILED').map(provider => provider.provider).join(', ')} returned an error. No booking or payment was attempted.</p></div></div>}{data.funnel.length > 0 && <ol className="search-funnel" aria-label="Search results">{data.funnel.map((step, i) => <li key={i}><strong>{step.count}</strong><span>{step.label}</span>{i < data.funnel.length - 1 && <ChevronRight size={16} />}</li>)}</ol>}<div className="offers-toolbar"><div className="segmented" aria-label="Results view"><button onClick={() => setView('stays')} aria-pressed={view === 'stays'}>The stays</button><button onClick={() => setView('understanding')} aria-pressed={view === 'understanding'}>How they compare</button></div><label className="filter-check"><input type="checkbox" checked={filter === 'feasible'} onChange={event => setFilter(event.target.checked ? 'feasible' : 'all')} />Only suitable stays</label></div>{data.recommendedOfferId && data.recommendationReasons.length > 0 && <section className="recommendation-story"><span className="tiny-star">✳</span><div><h3>Why this one rose to the top</h3><ul>{data.recommendationReasons.map((reason, index) => <li key={index}><Check size={15} />{reason}</li>)}</ul></div></section>}{data.recommendedOfferId && <PublicExplanationCard key={data.offers.map(offer => `${offer.offerId}:${offer.offerVersion}`).join('|')} roomId={roomId} recommendedOfferId={data.recommendedOfferId} offerVersion={data.offers.find(offer => offer.offerId === data.recommendedOfferId)!.offerVersion} />}{view === 'stays' ? <div className="offers-grid">{data.offers.filter(offer => filter === 'all' || offer.feasible).map(offer => <OfferCard key={`${offer.offerId}-${offer.offerVersion}`} offer={offer} recommended={offer.offerId === data.recommendedOfferId} />)}</div> : data.matrix ? <section className="panel"><h2>Private boundaries. A shared answer.</h2><p className="subtle">Anonymous checks returned by Accord. No names, personal limits, or reasons are shown.</p><div className="matrix-scroll" role="region" aria-label="Anonymous feasibility comparison" tabIndex={0}><table><caption className="sr-only">Actual backend solver checks by offer</caption><thead><tr><th scope="col">Confirmed requirements</th>{data.matrix.offers.map(offer => <th scope="col" key={offer.id}>{offer.label}</th>)}</tr></thead><tbody>{data.matrix.rows.map(row => <tr key={row.id}><th scope="row">{row.label}</th>{row.results.map((result, index) => <td key={index}><CheckStatus status={result} /></td>)}</tr>)}</tbody></table></div><p className="fine">✓ Pass · × Does not pass · ? Missing evidence. Unknown evidence never means a requirement is met.</p></section> : <Empty title="Comparison isn’t available yet.">Your group’s solver comparison will appear after a search.</Empty>}{data.offers.length === 0 && <section className="panel"><Empty title="Still looking for your common ground.">No current option has been returned.</Empty><Button disabled={action.busy} onClick={() => action.run(async () => { await post(`/rooms/${segment(roomId)}/solve`, { retry: true }); resource.refresh(); })}>{action.busy ? 'Searching Nuitée Connect…' : data.providerResults.length ? 'Try the search again' : 'Search Nuitée Connect'}<ArrowRight size={16} /></Button></section>}{filter === 'feasible' && data.offers.length > 0 && !data.offers.some(offer => offer.feasible) && <Empty title="No shared yes just yet.">No current option satisfies everyone’s confirmed requirements. You can review your own requirements privately.</Empty>}</>}</div>;
}

export function Proposal({ privateView = false }: { privateView?: boolean }) {
  // Route identity prevents private state from lingering when switching proposals.
  const { proposalId = '' } = useParams();
  return <ProposalContent key={`${proposalId}-${privateView}`} proposalId={proposalId} privateView={privateView} />;
}
function ProposalContent({ proposalId, privateView }: { proposalId: string; privateView: boolean }) {
  const base = `/proposals/${segment(proposalId)}`;
  const [roomId, setRoomId] = useState<string>();
  const live = useRoomEvents(roomId);
  const resource = useResource<ProposalEnvelope | PrivateProposalEnvelope>(`${base}/${privateView ? 'me' : 'public'}`, live.revision);
  const action = useAction();
  const execute = useAction();
  const navigate = useNavigate();
  const idempotency = useRef(crypto.randomUUID());
  const [now, setNow] = useState(Date.now());
  const [acknowledgedHash, setAcknowledgedHash] = useState<string>();
  const data = resource.data;
  const proposal = data?.proposal;
  const personal = data && 'myContributionCents' in data ? data : undefined;
  useEffect(() => { if (data?.roomId) setRoomId(data.roomId); }, [data?.roomId]);
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  const expired = !!proposal && new Date(proposal.expiresAt).getTime() <= now;
  const stale = proposal?.state === 'STALE';
  const approved = personal?.myApprovalStatus === 'APPROVED';
  const authorized = personal?.myPaymentStatus === 'AUTHORIZED' || personal?.myPaymentStatus === 'CAPTURED';
  const canSubmit = !!personal && personal.proposal.state === 'OPEN' && !expired && !approved && !resource.loading && !resource.error && acknowledgedHash === proposal?.proposalHash;
  const approve = () => action.run(async () => {
    if (!personal || !proposal) return;
    try {
      const result = await post<ConsentResponseDTO>(`${base}/consent`, { proposalHash: proposal.proposalHash, version: proposal.version, amountCents: personal.myContributionCents }, { 'Idempotency-Key': idempotency.current });
      if (result.proposalHash !== proposal.proposalHash || result.version !== proposal.version || result.amountCents !== personal.myContributionCents || result.approvalStatus !== 'APPROVED') throw new Error('We couldn’t verify the approval result. Refresh before trying again.');
      if (data?.roomId) navigate(`/rooms/${segment(data.roomId)}`);
    } finally { setAcknowledgedHash(undefined); resource.refresh(); }
  });
  if (privateView) {
    const problems = personal?.myConstraintChecks.filter(check => check.status !== 'PASS') ?? [];
    return <div className="page step-room">
      {roomId && <Link to={`/rooms/${segment(roomId)}`} className="back-link"><ArrowLeft size={15} />Back</Link>}
      {resource.loading && !data && <Loading />}
      <ErrorNotice error={resource.error} retry={resource.refresh} />
      {data && proposal && personal && <section className="step-card">
        <p className="step-from"><Sparkles size={14} />Accord</p>
        <h2>{stale ? 'This stay changed.' : approved ? 'You’ve approved.' : 'Approve your share.'}</h2>
        <h3>{proposal.offer.propertyName}</h3>
        <p className="subtle">{proposal.offer.city} · {calendarDate(proposal.offer.checkInDate)} – {calendarDate(proposal.offer.checkOutDate)}</p>
        <p className="step-price"><strong>{money(personal.myContributionCents)}</strong></p>
        {problems.length > 0 ? <ul className="why-list">{problems.map(check => <li key={check.label}>{check.label}. {check.privateExplanation}</li>)}</ul> : !stale && <p>This fits what you told Accord.</p>}
        {!stale && !approved && proposal.state === 'OPEN' && <>
          <label className="checkbox-row"><input type="checkbox" checked={acknowledgedHash === proposal.proposalHash} onChange={event => setAcknowledgedHash(event.target.checked ? proposal.proposalHash : undefined)} /><span>This is the stay and the amount I mean.</span></label>
          <div className="step-action"><Button disabled={!canSubmit || action.busy} onClick={approve}>{action.busy ? 'Saving…' : `Approve ${money(personal.myContributionCents)}`}</Button></div>
        </>}
        {approved && !stale && <div className="step-action"><LinkButton to={`/rooms/${segment(data.roomId)}`}>Back to the trip</LinkButton></div>}
        {stale && <div className="step-action"><LinkButton to={`/rooms/${segment(data.roomId)}`}>Back to the trip</LinkButton></div>}
        <ErrorNotice error={action.error} />
      </section>}
    </div>;
  }
  return <div className="page">
    {roomId && <Link to={`/rooms/${segment(roomId)}`} className="back-link"><ArrowLeft size={15} />Back to your group</Link>}
    <PageHeading eyebrow={privateView ? 'Your decision. Your exact contribution.' : 'One plan. Everyone on board.'} title={stale ? 'The offer changed. Your trust shouldn’t.' : proposal ? `A shared stay in ${proposal.offer.city}.` : 'Your shared proposal'} aside={proposal && <Tag>Proposal v{proposal.version}</Tag>} />
    {resource.loading && !data && <Loading />}
    <ErrorNotice error={resource.error} retry={resource.refresh} />
    {data && proposal && <>
      {stale && <Stale changes={data.changes}><p className="replanning-note"><span className="autopilot-dot" aria-hidden="true" />Accord is finding the group another option on its own.</p><Button disabled={execute.busy} onClick={() => execute.run(async () => { await post(`/rooms/${segment(data.roomId)}/solve`, { replan: true }); navigate(`/rooms/${segment(data.roomId)}`); })}>See the latest option <ArrowRight size={17} /></Button></Stale>}
      {expired && !stale && proposal.state !== 'BOOKED' && <div className="notice" role="status"><Clock3 size={20} /><p>This offer has expired. Return to your group for a current proposal and fresh consent.</p></div>}
      <div className="proposal-grid">
        <section className="panel proposal-detail"><StayArt city={proposal.offer.city} large /><div className="proposal-detail-body">
          <div className="between"><p className="eyebrow"><MapPin size={14} />{proposal.offer.city}</p><Tag>{proposal.state.replaceAll('_', ' ').toLowerCase()}</Tag></div>
          <h2>{proposal.offer.propertyName}</h2><p className="subtle">{data.inventoryLabel}</p><OfferFacts offer={proposal.offer} /><hr />
          <dl className="price-breakdown"><div><dt>Accommodation subtotal</dt><dd>{money(proposal.offer.subtotalCents)}</dd></div><div><dt>Mandatory fees</dt><dd>{money(proposal.offer.mandatoryFeesCents)}</dd></div><div className="total"><dt>All-in total</dt><dd>{money(proposal.offer.totalCents)}</dd></div><div><dt>Equal share</dt><dd>{money(proposal.equalShareCents)} per person</dd></div></dl>
          <p className="fine">{proposal.approval.requiredCount} active payers · Merchant: {proposal.offer.merchantName}<br />Offer version {proposal.offer.offerVersion} · Expires {dateTime(proposal.expiresAt)}</p>
          <WatchLine proposal={proposal} now={now} /><Stability offer={proposal.offer} /><Integrity proposal={proposal} previousHash={data.previousProposalHash} currentHash={data.currentProposalHash} />
        </div></section>
        <aside className="stack">
          {personal && roomId && <Inbox roomId={roomId} revision={live.revision} limit={3} />}
          {personal && <PrivateExplanationCard key={`${proposal.proposalHash}:${proposal.state}:${JSON.stringify(personal.myConstraintChecks)}`} proposalId={proposal.proposalId} proposalHash={proposal.proposalHash} />}
          {personal ? <section className="panel consent-panel">
            <span className="icon-circle"><LockKeyhole size={21} /></span><p className="eyebrow">Just for you</p>
            <h2>{stale ? 'Your previous approval will not be used.' : approved ? 'Your part is confirmed.' : 'Your share. Your say.'}</h2>
            <div className="consent-price">{money(personal.myContributionCents)}<span>Your exact contribution</span></div>
            <div className="my-checks">{personal.myConstraintChecks.map((check, index) => <div key={index}><CheckStatus status={check.status} /><div><strong>{check.label}</strong><p>{check.privateExplanation}</p></div></div>)}</div>
            <div className="status-pair"><span>Approval <strong>{personal.myApprovalStatus.toLowerCase()}</strong></span><span>Payment <strong>{personal.myPaymentStatus.toLowerCase()}</strong></span></div>
            <div className="status-pair"><span>My shared-wallet allocation <strong>{money(personal.wallet.heldCents)}</strong></span><span>Captured allocation <strong>{money(personal.wallet.spentCents)}</strong></span></div>
            {personal.wallet.transactionId && <p className="fine">Shared CyberSource transaction <code>{personal.wallet.transactionId}</code> · the group has one sandbox card transaction, not one card charge per member.</p>}
            <p className="provider-label">{data.paymentModeLabel}</p>
            {!stale && !approved && proposal.state === 'OPEN' && <>
              <p>You are approving Proposal v{proposal.version} and permitting Accord to process your exact {money(personal.myContributionCents)} share after everyone approves.</p>
              <p className="fine">If the price or terms change, this approval cannot be reused.</p>
              <label className="checkbox-row consent-checkbox"><input type="checkbox" checked={acknowledgedHash === proposal.proposalHash} onChange={event => setAcknowledgedHash(event.target.checked ? proposal.proposalHash : undefined)} /><span>I’ve reviewed this exact offer and my contribution.</span></label>
              <Button disabled={!canSubmit || action.busy} onClick={() => action.run(async () => {
                try {
                  const result = await post<ConsentResponseDTO>(`${base}/consent`, { proposalHash: proposal.proposalHash, version: proposal.version, amountCents: personal.myContributionCents }, { 'Idempotency-Key': idempotency.current });
                  if (result.proposalHash !== proposal.proposalHash || result.version !== proposal.version || result.amountCents !== personal.myContributionCents || result.approvalStatus !== 'APPROVED') throw new Error('We couldn’t verify the approval result. Refresh before trying again.');
                } finally { setAcknowledgedHash(undefined); resource.refresh(); }
              })}>{action.busy ? 'Recording approval…' : `Approve my ${money(personal.myContributionCents)} share`}<ShieldCheck size={17} /></Button>
            </>}
            {approved && !stale && <div className="feasibility"><CheckCheck size={18} />Approval recorded for Proposal v{proposal.version}. {authorized ? 'The shared Visa authorization is confirmed.' : 'The shared payment starts automatically after everyone approves.'}</div>}
            <ErrorNotice error={action.error} /><PrivateNote />
          </section> : <section className="panel decision-invitation"><LockKeyhole size={22} /><h3>Make it your decision.</h3><p>Review your private checks and approve your exact contribution.</p><LinkButton to={`${base}/me`}>Review my part</LinkButton></section>}
          <Funding proposal={proposal} />
          {proposal.state === 'BOOKED' && <LinkButton to={`/rooms/${segment(data.roomId)}/receipt`}>View booking receipt</LinkButton>}
          {proposal.state === 'READY_TO_EXECUTE' && <section className="panel"><h3>Payment and booking need to finish.</h3><p>Accord normally runs this automatically. If a provider or credential problem interrupted it, this safely resumes the unfinished step.</p><p className="provider-label">{data.bookingModeLabel}</p><Button disabled={execute.busy} onClick={() => execute.run(async () => { await post(`${base}/execute`, { proposalHash: proposal.proposalHash }, { 'Idempotency-Key': `resume-${proposal.proposalHash}` }); resource.refresh(); navigate(`/rooms/${segment(data.roomId)}`); })}>{execute.busy ? 'Resuming…' : 'Resume secure checkout'}<ShieldCheck size={17} /></Button></section>}
          <ErrorNotice error={execute.error} />
        </aside>
      </div>
    </>}
  </div>;
}

export function Receipt() {
  const { roomId = '' } = useParams();
  const live = useRoomEvents(roomId);
  const base = `/rooms/${segment(roomId)}`;
  const resource = useResource<ReceiptDTO>(`${base}/receipt`, live.revision);
  const events = useResource<{ events: EventDTO[] }>(`${base}/events`, live.revision);
  const receipt = resource.data;
  return <div className="page receipt-page narrow">
    <Link to={base} className="back-link"><ArrowLeft size={15} />Your group</Link>
    {resource.loading && !receipt && <Loading />}<ErrorNotice error={resource.error} retry={resource.refresh} />
    {receipt && <>
      <div className="receipt-heading"><span className="receipt-check"><Check size={34} /></span><p className="eyebrow">Everyone agreed. Every detail checked.</p><h1>{receipt.status === 'HANDOFF' ? 'Approved. Ready to book.' : 'Booked and paid.'}</h1><p>{receipt.confirmationLabel}</p><Tag>{receipt.providerModeLabel}</Tag>{receipt.status === 'HANDOFF' && receipt.externalUrl && <p><a className="button" href={receipt.externalUrl} target="_blank" rel="noopener noreferrer">Continue on {receipt.proposal.offer.merchantName}</a></p>}</div>
      <section className="panel receipt"><p className="eyebrow">Your shared stay</p><h2>{receipt.proposal.offer.propertyName}</h2><OfferFacts offer={receipt.proposal.offer} />
        <dl className="boundary-list"><div><dt>Guests</dt><dd>{receipt.guestCount}</dd></div><div><dt>All-in total</dt><dd>{money(receipt.proposal.offer.totalCents)}</dd></div><div><dt>Equal share</dt><dd>{money(receipt.proposal.equalShareCents)} each</dd></div><div><dt>Proposal</dt><dd>v{receipt.proposal.version}</dd></div><div><dt>Booking reference</dt><dd>{receipt.bookingReference}</dd></div><div><dt>Confirmed</dt><dd>{dateTime(receipt.bookedAt)}</dd></div><div><dt>Provider mode</dt><dd>{receipt.providerModeLabel}</dd></div><div><dt>Visa sandbox captured</dt><dd>{money(receipt.payment.capturedTotalCents)} in {receipt.payment.transactionCount} shared transaction{receipt.payment.transactionCount === 1 ? '' : 's'}</dd></div>{receipt.payment.transactionId && <div><dt>Payment reference</dt><dd><code>{receipt.payment.transactionId}</code></dd></div>}</dl>
        <Integrity proposal={receipt.proposal} />
      </section>
      {events.data && <Timeline events={events.data.events} />}<ErrorNotice error={events.error} retry={events.refresh} />
    </>}
  </div>;
}

const mutations: Array<[MerchantMutation, string]> = [
  [{ type: 'INCREASE_PRICE', newTotalCents: 0 }, 'Simulate a 20% price increase'],
  [{ type: 'CHANGE_CANCELLATION', code: 'TRAVEL_CREDIT' }, 'Change refund policy to travel credit'],
  [{ type: 'SELL_OUT' }, 'Sell out'],
  [{ type: 'CHANGE_ROOM', roomType: 'Changed demo suite' }, 'Change room'],
  [{ type: 'CHANGE_CAPACITY', guestCapacity: 3 }, 'Reduce capacity'],
  [{ type: 'CHANGE_STEP_FREE', value: null }, 'Change accessibility verification'],
  [{ type: 'ADD_MANDATORY_FEE', feeDeltaCents: 5000 }, 'Add mandatory fee'],
  [{ type: 'FAIL_NEXT_BOOKING' }, 'Trigger booking failure'],
  [{ type: 'RESTORE' }, 'Restore'],
];
export function Merchant() {
  const { roomId } = useParams();
  const roomBase = roomId ? `/rooms/${segment(roomId)}` : '';
  const resource = useResource<MerchantDTO>(roomId ? `${roomBase}/demo/merchant` : '/demo/merchant');
  const action = useAction();
  const [selected, setSelected] = useState('');
  const [confirmReset, setConfirmReset] = useState(false);
  const [lastAction, setLastAction] = useState('');
  const analytics = useResource<AnalyticsDTO>(resource.data ? '/demo/analytics' : null);
  const offer = resource.data?.offers.find(item => item.offerId === selected) || resource.data?.offers[0];
  return <div className="page">
    {roomId && <Link to={roomBase} className="back-link"><ArrowLeft size={15} />Back to your group</Link>}
    <PageHeading eyebrow="Authenticated demo administration" title="Simulate a provider change." description="Real prices change on their own; these controls simulate that on stage by changing Accord’s stored copy of an offer. They never change the provider’s real listing. Host only." />
    <Tag tone="warm">Synthetic judge/demo view — not visible to ordinary room members</Tag>
    {resource.loading && <Loading />}<ErrorNotice error={resource.error} retry={resource.refresh} />
    {resource.data && <div className="room-grid"><section className="panel form-panel">
      <label htmlFor="merchant-offer">Current merchant offer</label>
      <select id="merchant-offer" value={offer?.offerId || ''} onChange={event => setSelected(event.target.value)}>{resource.data.offers.map(item => <option key={item.offerId} value={item.offerId}>{item.propertyName}</option>)}</select>
      {offer && <><h2>{offer.propertyName}</h2><p>Current offer version: <strong>{offer.offerVersion}</strong></p><p>{money(offer.totalCents)} · {offer.cancellationLabel} · {offer.available ? 'Available' : 'Unavailable'}</p><div className="mutation-grid">{mutations.map(([mutation, label]) => <Button className="secondary" key={mutation.type} disabled={action.busy || resource.loading} onClick={() => action.run(async () => {
        await post(roomId ? `${roomBase}/merchant/events` : '/merchant/events', { offerId: offer.offerId, expectedOfferVersion: offer.offerVersion, mutation: mutation.type === 'INCREASE_PRICE' ? { ...mutation, newTotalCents: Math.round(offer.totalCents * 1.2) } : mutation });
        setLastAction(`${label} — a new offer version was recorded. Any active proposal for the old version is now stale and cannot execute.`); resource.refresh(); analytics.refresh();
      })}>{label}<ArrowRight size={15} /></Button>)}</div></>}
      <p role="status">{lastAction}</p><ErrorNotice error={action.error} /><hr />
      {confirmReset ? <div><p>Reset the demo’s rooms, sessions, merchant offers, and payment ledger? Existing browser sessions will be signed out.</p><div className="button-row"><Button disabled={action.busy} onClick={() => action.run(async () => { await post('/demo/reset', { confirmed: true }); setConfirmReset(false); setLastAction('Demo reset confirmed by backend.'); resource.refresh(); analytics.refresh(); })}>Confirm demo reset</Button><Button className="secondary" onClick={() => setConfirmReset(false)}>Cancel</Button></div></div> : <Button className="secondary" onClick={() => setConfirmReset(true)}><RefreshCw size={15} />Reset demo</Button>}
    </section><aside>{analytics.data?.source === 'TIGER' ? <TigerChart data={analytics.data} /> : <section className="panel"><h3>Proof this offer hasn't quietly changed</h3><Empty title="Tiger-backed analytics are unavailable.">No observed price timeline can be shown here without Tiger Data configured — nothing is fabricated in its place.</Empty></section>}</aside></div>}
  </div>;
}
function TigerChart({ data }: { data: AnalyticsDTO }) {
  const points = data.points.filter(point => Number.isFinite(point.totalCents) && Number.isFinite(Date.parse(point.at)));
  if (!points.length) return <section className="panel"><h3>Proof this offer hasn't quietly changed</h3><Empty title="No recorded price events yet.">Every merchant mutation you trigger below is written to Tiger Data and appears here immediately, timestamped — this is what lets Accord catch a repriced offer after a group has already approved it.</Empty></section>;
  const times = points.map(point => Date.parse(point.at));
  const minTime = Math.min(...times), maxTime = Math.max(...times);
  const min = Math.min(...points.map(point => point.totalCents)), max = Math.max(...points.map(point => point.totalCents));
  const coords = points.map(point => ({ x: 65 + (Date.parse(point.at) - minTime) / Math.max(1, maxTime - minTime) * 410, y: 180 - (point.totalCents - min) / Math.max(1, max - min) * 135 }));
  return <section className="panel"><h3>Proof this offer hasn't quietly changed</h3><p className="subtle">Every recorded price for this offer, straight from Tiger Data · this planning session</p><svg className="timeline-chart" viewBox="0 0 500 220" role="img" aria-label="Offer price at recorded transaction events"><line x1="65" x2="480" y1="180" y2="180" stroke="#c9cec6" /><text x="0" y="48">{money(max)}</text><text x="0" y="184">{money(min)}</text><polyline fill="none" stroke="#2a78d6" strokeWidth="2" points={coords.map(p => `${p.x},${p.y}`).join(' ')} />{coords.map((point, i) => <circle key={i} cx={point.x} cy={point.y} r="5" fill="#2a78d6"><title>{points[i].label}: {money(points[i].totalCents)} at {dateTime(points[i].at)}</title></circle>)}</svg><ol className="chart-legend">{points.map((point, index) => <li key={index}><span>{point.label}</span><strong>{money(point.totalCents)}</strong><time>{dateTime(point.at)}</time></li>)}</ol></section>;
}
