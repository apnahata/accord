import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, Check, CheckCheck, CircleHelp, ExternalLink, LockKeyhole, MapPin, ShieldCheck, Users, X } from 'lucide-react';
import type { EventDTO, PublicOfferDTO, PublicProposalDTO, PublicChange } from './contracts';
import { date, dateTime, money, safeExplorer } from './api';

export function Brand() { return <Link to="/" className="brand" aria-label="Accord home"><span className="brand-mark" aria-hidden="true">a</span>accord<span className="brand-dot">®</span></Link>; }
export function Button({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) { return <button {...props} className={`button ${props.className || ''}`}>{children}</button>; }
export function LinkButton({ to, children, secondary = false }: { to: string; children: ReactNode; secondary?: boolean }) { return <Link to={to} className={`button ${secondary ? 'secondary' : ''}`}>{children}<ArrowRight size={17} /></Link>; }
export function Tag({ children, tone = '' }: { children: ReactNode; tone?: string }) { return <span className={`tag ${tone}`}>{children}</span>; }
export function PrivateNote() { return <div className="private-note"><LockKeyhole size={17} /><span>Your budget and personal requirements stay private from the rest of the group.</span></div>; }
export function ErrorNotice({ error, retry }: { error?: Error; retry?: () => void }) {
  if (!error) return null;
  return <div className="notice error" role="alert"><CircleHelp size={20} /><div><strong>Let’s pause here</strong><p>{error.message}</p>{retry && <button className="text-button" onClick={retry}>Try again <ArrowRight size={14} /></button>}</div></div>;
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
  return <dl className="offer-facts"><div><dt>Stay</dt><dd>{date(offer.checkInAt)} – {date(offer.checkOutAt)}</dd></div><div><dt>Room</dt><dd>{offer.roomType}</dd></div><div><dt>Capacity</dt><dd>{offer.guestCapacity} guests</dd></div><div><dt>Cancellation</dt><dd>{offer.cancellationLabel}</dd></div><div><dt>Accessibility evidence</dt><dd>{offer.stepFreeVerified === null ? 'Step-free access unverified' : offer.stepFreeVerified ? 'Verified step-free access' : 'Not verified step-free'}</dd></div><div><dt>Checkout</dt><dd>{dateTime(offer.checkOutAt)}</dd></div></dl>;
}
export function Stability({ offer }: { offer: PublicOfferDTO }) {
  if (!offer.stability) return null;
  return <div className="stability" title="Observed stability during this Accord planning session. Not a prediction of future prices."><span className="stability-bars" aria-hidden="true">▂▄▃▅</span><span>{offer.stability.label.toLowerCase()} · {offer.stability.materialChangeCount} material changes <small>{offer.stability.observationCount} observations this session</small></span></div>;
}
export function OfferCard({ offer, recommended = false, children }: { offer: PublicOfferDTO; recommended?: boolean; children?: ReactNode }) {
  return <article className={`offer-card ${recommended ? 'recommended' : ''}`}><div className="offer-image"><StayArt city={offer.city} />{recommended && <span className="recommendation">✦ Accord’s recommendation</span>}</div><div className="offer-body"><div className="offer-location"><MapPin size={13} />{offer.city}<span>{offer.available ? 'Available' : 'Unavailable'}</span></div><h3>{offer.propertyName}</h3><p className="subtle">{offer.roomType} · Up to {offer.guestCapacity} guests</p><p className="offer-dates">{date(offer.checkInAt)} – {date(offer.checkOutAt)}</p><div className={`feasibility ${offer.feasible ? '' : 'unmet'}`}>{offer.feasible ? <CheckCheck size={17} /> : <CircleHelp size={17} />}<span>{offer.feasible ? 'Works for everyone’s confirmed requirements' : 'Doesn’t currently satisfy all confirmed requirements'}</span></div><div className="price-row"><div><strong>{money(offer.equalShareCents)}</strong><span> / person</span></div><span>{money(offer.totalCents)} total</span></div><Stability offer={offer} /><details><summary>View stay details</summary><OfferFacts offer={offer} /><p className="subtle">Merchant: {offer.merchantName}<br />Offer v{offer.offerVersion} · Expires {dateTime(offer.expiresAt)}</p><p className="subtle">Mandatory fees: {money(offer.mandatoryFeesCents)}, included</p></details>{children}</div></article>;
}
export function Funding({ proposal }: { proposal: PublicProposalDTO }) {
  const a = proposal.authorization;
  const invalidated = proposal.state === 'STALE' || proposal.state === 'CANCELLED';
  return <section className="panel funding"><div className="section-heading"><h3>One shared agreement</h3><ShieldCheck size={21} /></div>{invalidated ? <p>Previous authorizations cannot be used. Fresh consent is required for a new proposal.</p> : <><div className="funding-count"><strong>{a.authorizedCount}<span> / {a.requiredCount}</span></strong><span>authorizations complete</span></div><progress aria-label="Member authorizations" max={Math.max(1, a.requiredCount)} value={a.authorizedCount} /><div className="between subtle"><span>{money(a.authorizedTotalCents)} authorized</span><span>{money(a.requiredTotalCents)} total</span></div><p className="fine">Everyone approves their exact share of this exact proposal.</p></>}</section>;
}
export function Integrity({ proposal, previousHash, currentHash }: { proposal: PublicProposalDTO; previousHash?: string; currentHash?: string }) {
  const link = proposal.solana?.status === 'CONFIRMED' && proposal.solana.transactionSignature ? safeExplorer(proposal.solana.explorerUrl) : undefined;
  return <section className="integrity"><ShieldCheck size={19} /><div><h4>Proposal integrity</h4><p>{link ? 'Recorded on Solana devnet' : proposal.solana?.status === 'PENDING' ? 'Integrity commitment pending' : 'Integrity commitment unavailable'}</p><details><summary>View proposal fingerprint</summary><code>{proposal.proposalHash}</code>{previousHash && <><p>Previously approved hash</p><code>{previousHash}</code></>}{currentHash && <><p>Current proposal hash</p><code>{currentHash}</code></>}{previousHash && currentHash && previousHash !== currentHash && <p>Different proposal · Fresh consent required</p>}</details>{link && <a href={link} target="_blank" rel="noreferrer">View transaction <ExternalLink size={13} /></a>}</div></section>;
}
export function Stale({ changes, children }: { changes?: PublicChange[]; children?: ReactNode }) {
  return <section className="stale-panel" role="status"><div className="stale-symbol" aria-hidden="true"><span /><span /></div><p className="eyebrow">Protected by Accord</p><h2>Consent stale</h2><p className="stale-lead">This is no longer the offer the group approved.</p>{!!changes?.length && <dl className="changes">{changes.map((change, i) => <div key={i}><dt>{change.label}</dt><dd><del>{change.before}</del><ArrowRight size={16} /><strong>{change.after}</strong></dd></div>)}</dl>}<p>Accord paused the purchase. The updated offer cannot use the group’s previous authorizations.</p>{children}</section>;
}
export function Timeline({ events }: { events: EventDTO[] }) {
  return <section className="panel"><div className="section-heading"><h3>Coming together</h3><span className="eyebrow">Activity</span></div>{events.length === 0 ? <p className="subtle">Your group’s activity will appear here.</p> : <ol className="timeline">{events.map(event => <li key={event.id}><span className="timeline-dot" /><div><time dateTime={event.occurredAt}>{new Date(event.occurredAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}</time><strong>{event.title}</strong>{event.detail && <p>{event.detail}</p>}</div></li>)}</ol>}</section>;
}
export function CheckStatus({ status }: { status: 'PASS' | 'FAIL' | 'UNKNOWN' }) { return <span className={`check-status ${status.toLowerCase()}`} aria-label={status === 'PASS' ? 'Pass' : status === 'FAIL' ? 'Does not pass' : 'Unknown'}>{status === 'PASS' ? <Check size={18} /> : status === 'FAIL' ? <X size={18} /> : <CircleHelp size={17} />}</span>; }
