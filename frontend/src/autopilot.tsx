import { Link } from 'react-router-dom';
import { LockKeyhole, Sparkles } from 'lucide-react';
import { Button, ErrorNotice } from './components';
import { post, segment } from './api';
import { useAction, useResource } from './hooks';
import type { AutopilotDTO, InboxDTO, InboxMessageDTO, PublicProposalDTO } from './contracts';

const headings: Record<AutopilotDTO['status'], string> = {
  IDLE: 'Accord', WAITING_FOR_MEMBERS: 'Accord is waiting for everyone', SEARCHING: 'Accord is searching',
  REPLANNING: 'Accord is replanning', WIDENING: 'Accord is widening the search', WATCHING: 'Accord is keeping watch', NO_OPTION: 'No shared yes yet',
  PLANNING: 'Accord is planning the trip', VOTING: 'Your group is voting',
};

export function AutopilotBanner({ autopilot }: { autopilot?: AutopilotDTO }) {
  if (!autopilot?.message) return null;
  const busy = autopilot.status === 'SEARCHING' || autopilot.status === 'REPLANNING' || autopilot.status === 'WIDENING' || autopilot.status === 'PLANNING';
  return <div className={`autopilot-banner ${autopilot.status.toLowerCase()} ${busy ? 'busy' : ''}`} role="status" aria-live="polite"><span className="autopilot-mark" aria-hidden="true"><Sparkles size={16} /></span><div><strong>{headings[autopilot.status]}</strong><span>{autopilot.message}</span></div></div>;
}

export function relativeTime(value: string, now = Date.now()) {
  const seconds = Math.max(0, Math.round((now - Date.parse(value)) / 1000));
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours} hr ago` : new Date(value).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export function WatchLine({ proposal, now }: { proposal: PublicProposalDTO; now?: number }) {
  const watch = proposal.watch;
  if (!watch || proposal.state === 'STALE' || proposal.state === 'BOOKED') return null;
  return <p className="watch-line"><span aria-hidden="true" />{watch.method === 'SEARCH_TIME'
    ? 'Price as listed when Accord searched. This listing can’t be re-checked before the host continues on the listing site.'
    : `Accord last checked this ${watch.method === 'PROVIDER_REQUOTE' ? 'live price with the provider' : 'offer'} ${relativeTime(watch.lastCheckedAt, now)} and keeps re-checking until the group books.`}</p>;
}

const closed: Record<string, string> = { ACCEPTED: 'You updated your answers. Accord is looking again.', KEPT: 'You kept your requirement. Accord will keep looking.', EXPIRED: 'Your requirements changed since this was asked.' };

/** Private messages from Accord to the signed-in member only. Open questions float to the top. */
export function Inbox({ roomId, revision, limit = 5 }: { roomId: string; revision: number; limit?: number }) {
  const base = `/rooms/${segment(roomId)}`;
  const inbox = useResource<InboxDTO>(`${base}/me/inbox`, revision);
  const action = useAction();
  const messages = [...(inbox.data?.messages ?? [])].sort((a, b) => Number(b.nudge?.status === 'OPEN') - Number(a.nudge?.status === 'OPEN')).slice(0, limit);
  if (!messages.length) return null;
  const respond = (message: InboxMessageDTO, choice: 'ACCEPT' | 'KEEP') => action.run(async () => { await post(`${base}/me/inbox/${segment(message.id)}/respond`, { action: choice }); inbox.refresh(); });
  return <section className="panel inbox-panel" aria-label="Private messages from Accord"><div className="section-heading"><h3><Sparkles size={18} />From Accord, just for you</h3><LockKeyhole size={17} /></div><ul className="inbox-list">{messages.map(message => <li key={message.id} className={`inbox-item ${message.kind.toLowerCase()} ${message.nudge?.status === 'OPEN' ? 'open' : ''}`}><time dateTime={message.at}>{relativeTime(message.at)}</time><strong>{message.title}</strong><p>{message.body}</p>{message.nudge && (message.nudge.status === 'OPEN'
    ? <div className="button-row"><Button className="small" disabled={action.busy} onClick={() => respond(message, 'ACCEPT')}>{message.nudge.acceptLabel}</Button><Button className="secondary small" disabled={action.busy} onClick={() => respond(message, 'KEEP')}>{message.nudge.keepLabel}</Button></div>
    : <p className="fine">{closed[message.nudge.status]}</p>)}{message.proposalId && (message.kind === 'READY_TO_BOOK' || message.kind === 'REMINDER' || message.kind === 'EXPIRING') && <Link className="text-button" to={`/proposals/${segment(message.proposalId)}/me`}>Review the proposal</Link>}</li>)}</ul><p className="fine">Only you can see these. Accord never changes your requirements unless you choose to.</p><ErrorNotice error={action.error} /></section>;
}
