import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, Check, CheckCheck, CircleHelp, ExternalLink, LockKeyhole, MapPin, ShieldCheck, Sparkles, Users, X } from 'lucide-react';
import type { EventDTO, PublicOfferDTO, PublicProposalDTO, PublicChange } from './contracts';
import { calendarDate, dateTime, money, safeExplorer } from './api';
import { Sparkline } from './charts';

export function Brand() { return <Link to="/" className="brand" aria-label="Accord home"><span className="brand-mark" aria-hidden="true">a</span>accord<span className="brand-dot">®</span></Link>; }
export function Button({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) { return <button {...props} className={`button ${props.className || ''}`}>{children}</button>; }
export function LinkButton({ to, children, secondary = false }: { to: string; children: ReactNode; secondary?: boolean }) { return <Link to={to} className={`button ${secondary ? 'secondary' : ''}`}>{children}<ArrowRight size={17} /></Link>; }
export function Tag({ children, tone = '' }: { children: ReactNode; tone?: string }) { return <span className={`tag ${tone}`}>{children}</span>; }
export function PrivateNote() { return <div className="private-note"><LockKeyhole size={17} /><span>Your budget and personal requirements stay private from the rest of the group.</span></div>; }
export function ErrorNotice({ error, retry }: { error?: Error; retry?: () => void }) {
  if (!error) return null;
  const reference = 'code' in error && typeof error.code === 'string' ? error.code : undefined;
  return <div className="notice error" role="alert"><CircleHelp size={20} /><div><strong>Accord couldn’t continue</strong><p>{error.message}</p>{reference && <small>Error reference: {reference}</small>}{retry && <button className="text-button" onClick={retry}>Try again <ArrowRight size={14} /></button>}</div></div>;
}
export function Loading() { return <div className="loading" role="status"><span className="loader" /> Bringing everything together…</div>; }
export function PageHeading({ eyebrow, title, description, aside }: { eyebrow: string; title: string; description?: string; aside?: ReactNode }) {
  return <div className="page-heading"><div><p className="eyebrow">{eyebrow}</p><h1>{title}</h1>{description && <p className="lead">{description}</p>}</div>{aside}</div>;
}
export function Empty({ title, children }: { title: string; children: ReactNode }) { return <div className="empty"><span className="icon-circle"><Users size={24} /></span><h3>{title}</h3><p>{children}</p></div>; }

export function StayArt({ city, large = false }: { city: string; large?: boolean }) {
  return <div className={`stay-art ${large ? 'large' : ''} ${city.toLowerCase().includes('tampa') ? 'courtyard' : ''}`} role="img" aria-label="Illustrated coastal accommodation; not a property photograph"><span className="art-sun" /><span className="art-building"><i /><i /><i /></span><span className="art-pool" /><span className="art-plant plant-one" /><span className="art-plant plant-two" /><span className="art-caption">A little room to come together.</span><span className="art-label">Illustration</span></div>;
}
export function OfferFacts({ offer }: { offer: PublicOfferDTO }) {
  return <dl className="offer-facts"><div><dt>Stay</dt><dd>{calendarDate(offer.checkInDate)} – {calendarDate(offer.checkOutDate)}</dd></div><div><dt>Room</dt><dd>{offer.roomType}</dd></div><div><dt>Capacity</dt><dd>{offer.guestCapacity} guests</dd></div><div><dt>Cancellation</dt><dd>{offer.cancellationLabel}</dd></div><div><dt>Accessibility evidence</dt><dd>{offer.stepFreeVerified === null ? 'Step-free access unverified' : offer.stepFreeVerified ? 'Verified step-free access' : 'Not verified step-free'}</dd></div><div><dt>Check-in</dt><dd>{offer.checkInTimeKnown ? dateTime(offer.checkInAt, offer.timeZone) : 'Time not provided by hotel'}</dd></div><div><dt>Checkout</dt><dd>{offer.checkOutTimeKnown ? dateTime(offer.checkOutAt, offer.timeZone) : 'Time not provided by hotel'}</dd></div></dl>;
}
export function Stability({ offer }: { offer: PublicOfferDTO }) {
  const stability = offer.stability;
  if (!stability) return null;
  const changes = stability.materialChangeCount;
  const history = (stability.history ?? []).map(point => ({ at: point.at, value: point.totalCents }));
  if (stability.observationCount < 2) return <div className="stability" title="Accord records every price it sees in Tiger Data."><span><strong>Price tracking started</strong><small>Accord re-checks prices over time; stability appears after the next check.</small></span></div>;
  return <div className={`stability ${stability.label.toLowerCase()}`} title="Observed by Accord over the last 24 hours (Tiger Data). Not a prediction of future prices.">
    <span><strong>{stability.label === 'STABLE' ? 'Stable price' : stability.label === 'MIXED' ? 'Price moved' : 'Volatile price'}</strong> · {changes === 0 ? 'no changes' : `${changes} change${changes === 1 ? '' : 's'}`}{stability.minCents !== undefined && stability.maxCents !== undefined && stability.minCents !== stability.maxCents ? ` · ${money(stability.minCents)}–${money(stability.maxCents)}` : ''}
      <small>{stability.observationCount} price checks in the last 24h{stability.label === 'VOLATILE' ? ' · approve soon or expect a re-check' : ''}</small></span>
    <Sparkline points={history} format={money} />
  </div>;
}
export function Research({ offer }: { offer: PublicOfferDTO }) {
  const research = offer.research;
  if (!research || (!research.summary && !research.pros.length && !research.cons.length && !research.nearby.length)) return null;
  return <div className="research-card"><p className="eyebrow">What Accord found</p>{research.summary && <p className="research-summary">{research.summary} <small>AI summary of listing data</small></p>}{research.pros.length > 0 && <p><strong>Guests like:</strong> {research.pros.join(' · ')}</p>}{research.cons.length > 0 && <p><strong>Watch for:</strong> {research.cons.join(' · ')}</p>}{research.nearby.length > 0 && <p><strong>Nearby:</strong> {research.nearby.join(' · ')}</p>}<p className="fine">Source: {research.sourceLabel}</p></div>;
}
export function OfferCard({ offer, recommended = false, children }: { offer: PublicOfferDTO; recommended?: boolean; children?: ReactNode }) {
  return <article className={`offer-card ${recommended ? 'recommended' : ''}`}><div className="offer-image">{offer.imageUrl ? <img className="offer-photo" src={offer.imageUrl} alt={`Photo of ${offer.propertyName}`} loading="lazy" referrerPolicy="no-referrer" /> : <StayArt city={offer.city} />}<span className={`source-badge ${offer.source.toLowerCase()}`}>{offer.sourceLabel}</span>{recommended && <span className="recommendation">✦ Accord’s recommendation</span>}</div><div className="offer-body"><div className="offer-location"><MapPin size={13} />{offer.city}<span>{offer.available ? 'Available' : 'Unavailable'}</span></div><h3>{offer.propertyName}</h3><p className="subtle">{offer.roomType} · Up to {offer.guestCapacity} guests{offer.rating !== undefined && <> · ★ {offer.rating}/10{offer.reviewCount ? ` (${offer.reviewCount.toLocaleString('en-US')})` : ''}</>}</p><p className="offer-dates">{calendarDate(offer.checkInDate)} – {calendarDate(offer.checkOutDate)}</p><div className={`feasibility ${offer.feasible ? '' : 'unmet'}`}>{offer.feasible ? <CheckCheck size={17} /> : <CircleHelp size={17} />}<span>{offer.feasible ? 'Works for everyone’s confirmed requirements' : 'Doesn’t currently satisfy all confirmed requirements'}</span></div><div className="price-row"><div><strong>{money(offer.equalShareCents)}</strong><span> / person</span></div><span>{money(offer.totalCents)} total</span></div><Stability offer={offer} /><Research offer={offer} /><details><summary>View stay details</summary><OfferFacts offer={offer} />{offer.address && <p className="subtle">{offer.address}</p>}{offer.externalUrl && <p className="subtle"><a className="text-button" href={offer.externalUrl} target="_blank" rel="noopener noreferrer">View listing on {offer.merchantName} <ExternalLink size={12} /></a></p>}<p className="subtle">Merchant: {offer.merchantName}<br />Offer v{offer.offerVersion} · Expires {dateTime(offer.expiresAt)}</p><p className="subtle">Mandatory fees: {money(offer.mandatoryFeesCents)}, included</p></details>{children}</div></article>;
}
export function Funding({ proposal }: { proposal: PublicProposalDTO }) {
  const a = proposal.authorization;
  const approval = proposal.approval;
  const invalidated = proposal.state === 'STALE' || proposal.state === 'CANCELLED';
  const paymentLabel = a.status === 'PENDING' ? 'Shared payment waits for every approval' : a.status === 'AUTHORIZED' ? 'Shared Visa authorization ready' : a.status === 'CAPTURED' ? 'Shared Visa payment captured' : a.status === 'RELEASED' ? 'Shared Visa authorization reversed' : 'Shared Visa payment needs review';
  return <section className="panel funding"><div className="section-heading"><h3>One shared agreement</h3><ShieldCheck size={21} /></div>{invalidated ? <p>Previous approvals cannot be used. Fresh consent is required for a new proposal.</p> : <><div className="funding-count"><strong>{approval.approvedCount}<span> / {approval.requiredCount}</span></strong><span>contributions approved</span></div><progress aria-label="Member approvals" max={Math.max(1, approval.requiredCount)} value={approval.approvedCount} /><div className="between subtle"><span>{paymentLabel}</span><span>{money(a.authorizedTotalCents)} authorized</span></div><p className="fine">Each person approves an exact contribution. Once everyone agrees, Accord verifies the hotel, creates one shared Visa sandbox authorization for the group total, reserves the room, and captures that one payment.</p></>}</section>;
}
export function Integrity({ proposal, previousHash, currentHash }: { proposal: PublicProposalDTO; previousHash?: string; currentHash?: string }) {
  const link = proposal.solana?.status === 'CONFIRMED' && proposal.solana.transactionSignature ? safeExplorer(proposal.solana.explorerUrl) : undefined;
  return <section className="integrity"><ShieldCheck size={19} /><div><h4>Proposal integrity</h4><p>{link ? 'Group wallet approvals anchored on Solana devnet' : proposal.solana?.status === 'PENDING' ? 'Group approval commitment pending' : proposal.solana?.status === 'FAILED' ? 'Group approval commitment failed; Accord consent remains enforced' : 'No on-chain group approval recorded'}</p><details><summary>View proposal fingerprint and wallet proof</summary><p>Backend proposal hash</p><code>{proposal.proposalHash}</code>{proposal.solana?.approvalBundleHash && <><p>On-chain signature-bundle hash</p><code>{proposal.solana.approvalBundleHash}</code></>}{proposal.walletAttestations.length > 0 && <><p>{proposal.walletAttestations.length} verified wallet attestation{proposal.walletAttestations.length === 1 ? '' : 's'}</p>{proposal.walletAttestations.map((attestation, index) => <div key={`${attestation.publicKey}-${index}`}><code>{attestation.publicKey}</code><code>{attestation.signature}</code></div>)}</>}{previousHash && <><p>Previously approved hash</p><code>{previousHash}</code></>}{currentHash && <><p>Current proposal hash</p><code>{currentHash}</code></>}{previousHash && currentHash && previousHash !== currentHash && <p>Different proposal · Fresh consent required</p>}</details>{link && <a href={link} target="_blank" rel="noreferrer">View transaction <ExternalLink size={13} /></a>}</div></section>;
}
export function Stale({ changes, children }: { changes?: PublicChange[]; children?: ReactNode }) {
  return <section className="stale-panel" role="status"><div className="stale-symbol" aria-hidden="true"><span /><span /></div><p className="eyebrow">Protected by Accord</p><h2>Consent stale</h2><p className="stale-lead">This is no longer the offer the group approved.</p>{!!changes?.length && <dl className="changes">{changes.map((change, i) => <div key={i}><dt>{change.label}</dt><dd><del>{change.before}</del><ArrowRight size={16} /><strong>{change.after}</strong></dd></div>)}</dl>}<p>Accord paused the purchase. The updated offer cannot use the group’s previous authorizations.</p>{children}</section>;
}
export function Timeline({ events, limit = 14 }: { events: EventDTO[]; limit?: number }) {
  const shown = [...events].reverse().slice(0, limit);
  return <section className="panel"><div className="section-heading"><h3>Coming together</h3><span className="eyebrow">Latest first</span></div>{events.length === 0 ? <p className="subtle">Your group’s activity will appear here.</p> : <ol className="timeline">{shown.map(event => <li key={event.id} className={event.actor ? `actor-${event.actor.toLowerCase()}` : ''}><span className="timeline-dot" /><div><time dateTime={event.occurredAt}>{new Date(event.occurredAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}{event.actor === 'ACCORD' && <span className="actor-badge"><Sparkles size={10} />Accord</span>}{event.actor === 'MERCHANT' && <span className="actor-badge merchant">Merchant</span>}</time><strong>{event.title}</strong>{event.detail && <p>{event.detail}</p>}</div></li>)}</ol>}</section>;
}
export function CheckStatus({ status }: { status: 'PASS' | 'FAIL' | 'UNKNOWN' }) { return <span className={`check-status ${status.toLowerCase()}`} aria-label={status === 'PASS' ? 'Pass' : status === 'FAIL' ? 'Does not pass' : 'Unknown'}>{status === 'PASS' ? <Check size={18} /> : status === 'FAIL' ? <X size={18} /> : <CircleHelp size={17} />}</span>; }
