import { useRef, useState, type ReactNode } from 'react';
import { Check, ExternalLink, Sparkles } from 'lucide-react';
import { Button, ErrorNotice, LinkButton, Loading, StayArt } from './components';
import { calendarDate, money, post, segment } from './api';
import { useAction } from './hooks';
import { dayRange } from './planning';
import { TripChat } from './pages-intake';
import type { ConsentResponseDTO, InboxMessageDTO, PrivateProposalEnvelope, ProposalEnvelope, PublicRoomDTO } from './contracts';

type Room = PublicRoomDTO;
type Planning = NonNullable<Room['planning']>;

/** The one thing this person can do on the group page right now. */
export function StepCard({ room, base, proposal, personal, nudge, onChange }: {
  room: Room;
  base: string;
  proposal?: ProposalEnvelope;
  personal?: PrivateProposalEnvelope;
  nudge?: InboxMessageDTO;
  onChange: () => void;
}) {
  const you = room.members.find(member => member.isYou);
  const waiting = room.members.filter(member => !member.ready);
  const planning = room.planning;
  const undecided = planning && planning.stage !== 'DECIDED';
  const looking = room.status === 'SEARCHING' || ['SEARCHING', 'REPLANNING', 'WIDENING', 'PLANNING'].includes(room.autopilot.status);

  if (nudge?.nudge?.status === 'OPEN') return <NudgeCard roomId={room.id} nudge={nudge} onChange={onChange} />;
  if (undecided && planning.stage === 'VOTING') return <VoteCard room={room} base={base} planning={planning} onChange={onChange} />;
  if (undecided && planning.stage === 'PLANNING') return <Voice title="Finding a trip." busy />;
  if (undecided && planning.stage === 'NO_OPTION') return <Voice title="Nothing lines up yet." body={planning.message || 'If one person can move, Accord asks them privately. The group chat doesn’t start over.'} />;
  if (undecided) return <AnswerCard base={base} youReady={!!you?.ready} waiting={waiting} onChange={onChange} />;

  if (looking) return <Voice title="Finding a trip." busy />;
  if (room.status === 'BOOKED') return <Voice title="You're booked." action={<LinkButton to={`${base}/receipt`}>See the receipt</LinkButton>} />;
  if (room.status === 'STALE' || proposal?.proposal.state === 'STALE') return <Voice title="That stay changed. Looking for another." busy />;
  if (proposal && proposal.proposal.state !== 'CANCELLED') return <ProposalCard base={base} proposal={proposal} personal={personal} onChange={onChange} />;
  if (room.autopilot.status === 'NO_OPTION') return <Voice title="Nothing lines up yet." body={room.autopilot.message || 'If one person can move, Accord asks them privately.'} />;
  if (!you?.ready || waiting.length) return <AnswerCard base={base} youReady={!!you?.ready} waiting={waiting} onChange={onChange} />;
  return <Voice title="Everyone has answered." body="I'll look for a stay that works and put it here." busy />;
}

function Voice({ title, body, action, busy }: { title: string; body?: string; action?: ReactNode; busy?: boolean }) {
  return <section className="step-card" aria-live="polite">
    <p className="step-from"><Sparkles size={14} />Accord</p>
    <h2>{title}</h2>
    {body && <p>{body}</p>}
    {busy && <Loading />}
    {action && <div className="step-action">{action}</div>}
  </section>;
}

function AnswerCard({ base, youReady, waiting, onChange }: { base: string; youReady: boolean; waiting: Room['members']; onChange: () => void }) {
  const [invite, setInvite] = useState<string>();
  const action = useAction();
  const names = waiting.map(member => member.displayName);
  if (!youReady) return <TripChat roomPath={base} onSaved={onChange} />;
  return <section className="step-card" aria-live="polite">
    <p className="step-from"><Sparkles size={14} />Accord</p>
    <h2>{names.length ? `Waiting on ${list(names)}.` : 'Everyone has answered.'}</h2>
    <div className="step-action">
      <Button disabled={action.busy} onClick={() => action.run(async () => { const result = await post<{ inviteToken: string; inviteUrl?: string }>(`${base}/invites`); setInvite(result.inviteUrl ?? `${window.location.origin}/join/${segment(result.inviteToken)}`); })}>Invite someone</Button>
    </div>
    {invite && <div className="notice"><div><label htmlFor="room-invite">Share this link</label><input id="room-invite" value={invite} readOnly onFocus={event => event.target.select()} /></div></div>}
    <ErrorNotice error={action.error} />
  </section>;
}

function VoteCard({ room, base, planning, onChange }: { room: Room; base: string; planning: Planning; onChange: () => void }) {
  const action = useAction();
  const vote = (optionId: string) => action.run(async () => { await post(`${base}/plan/vote`, { optionId }); onChange(); });
  const mine = planning.options.find(option => option.id === planning.myVoteOptionId);
  return <section className="step-card" aria-live="polite">
    <p className="step-from"><Sparkles size={14} />Accord</p>
    <h2>{mine ? `You picked ${mine.destination}.` : 'Pick one.'}</h2>
    <p>{planning.votesCast} of {room.memberCount} have picked.</p>
    <LinkButton to={`/rooms/${segment(room.id)}/offers`} secondary>See every stay Accord found</LinkButton>
    <div className="step-options">{planning.options.map(option => {
      const chosen = planning.myVoteOptionId === option.id;
      return <article key={option.id} className={`trip-option ${chosen ? 'mine' : ''}`}>
        <StayArt city={option.destination} />
        <h3>{option.destination}</h3>
        <p className="subtle">{dayRange(option.checkIn, option.checkOut)} · {option.nights} nights</p>
        <p className="subtle">{option.propertyName}</p>
        {option.why.length > 0 && <ul className="why-list">{option.why.map((reason, index) => <li key={index}>{reason}</li>)}</ul>}
        <p className="step-price"><strong>{money(option.totalCents)}</strong> total</p>
        <p className="subtle">Split {room.memberCount} ways: {money(option.equalShareCents)} each</p>
        {option.votes !== undefined && <p className="subtle">{option.votes} {option.votes === 1 ? 'vote' : 'votes'}</p>}
        {chosen ? <p className="my-vote"><Check size={15} />Your vote</p> : <Button className={planning.myVoteOptionId ? 'secondary' : ''} disabled={action.busy} onClick={() => vote(option.id)}>{planning.myVoteOptionId ? 'Switch to this' : 'Choose this trip'}</Button>}
      </article>;
    })}</div>
    <ErrorNotice error={action.error} />
  </section>;
}

function ProposalCard({ base, proposal, personal, onChange }: { base: string; proposal: ProposalEnvelope; personal?: PrivateProposalEnvelope; onChange: () => void }) {
  const action = useAction();
  const idempotency = useRef(crypto.randomUUID());
  const offer = proposal.proposal.offer;
  const approved = proposal.proposal.approval.approvedCount;
  const required = proposal.proposal.approval.requiredCount;
  const booking = proposal.proposal.state === 'READY_TO_EXECUTE';
  const mine = personal?.myApprovalStatus === 'APPROVED';
  const amount = personal?.myContributionCents ?? proposal.proposal.equalShareCents;
  const sayYes = () => action.run(async () => {
    if (!personal) return;
    const result = await post<ConsentResponseDTO>(`/proposals/${segment(proposal.proposal.proposalId)}/consent`, {
      proposalHash: proposal.proposal.proposalHash, version: proposal.proposal.version, amountCents: personal.myContributionCents,
    }, { 'Idempotency-Key': idempotency.current });
    if (result.approvalStatus !== 'APPROVED') throw new Error('That yes didn’t stick. Try again.');
    onChange();
  });
  return <section className="step-card step-stay">
    <p className="step-from"><Sparkles size={14} />Accord</p>
    <h2>{booking ? 'Booking it.' : mine ? 'You said yes.' : 'Say yes to this stay.'}</h2>
    <StayArt city={offer.city} />
    <div className="step-stay-body">
      <h3>{offer.propertyName}</h3>
      <p className="subtle">{offer.city} · {calendarDate(offer.checkInDate)} – {calendarDate(offer.checkOutDate)}</p>
      <a className="listing-link" href={offer.externalUrl ?? `https://www.google.com/search?q=${encodeURIComponent(`${offer.propertyName} ${offer.city}`)}`} target="_blank" rel="noopener noreferrer">{offer.externalUrl ? 'View the listing' : 'Look up this hotel'}<ExternalLink size={14} /></a>
      <p className="step-price"><strong>{money(offer.totalCents)}</strong> total</p>
      <p className="subtle">Your share: {money(amount)} (split {required} ways)</p>
      <p>{approved} of {required} said yes.</p>
      <div className="step-action">
        {proposal.proposal.state === 'BOOKED'
          ? <LinkButton to={`${base}/receipt`}>See the receipt</LinkButton>
          : mine
            ? null
            : <Button disabled={!personal || action.busy} onClick={sayYes}>{action.busy ? 'Saving…' : `Approve my ${money(amount)} share`}</Button>}
      </div>
      <ErrorNotice error={action.error} />
    </div>
  </section>;
}

function NudgeCard({ roomId, nudge, onChange }: { roomId: string; nudge: InboxMessageDTO; onChange: () => void }) {
  const action = useAction();
  const respond = (choice: 'ACCEPT' | 'KEEP') => action.run(async () => {
    await post(`/rooms/${segment(roomId)}/me/inbox/${segment(nudge.id)}/respond`, { action: choice });
    onChange();
  });
  return <section className="step-card">
    <p className="step-from"><Sparkles size={14} />Accord · only you can see this</p>
    <h2>{nudge.title}</h2>
    <p>{nudge.body}</p>
    <div className="step-action">
      <Button disabled={action.busy} onClick={() => respond('ACCEPT')}>{nudge.nudge!.acceptLabel}</Button>
      <Button className="secondary" disabled={action.busy} onClick={() => respond('KEEP')}>{nudge.nudge!.keepLabel}</Button>
    </div>
    <ErrorNotice error={action.error} />
  </section>;
}

export function ReopenPlanning({ base, onChange }: { base: string; onChange: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const action = useAction();
  if (!confirming) return <button className="text-button" onClick={() => setConfirming(true)}>Plan the trip again</button>;
  return <div className="button-row">
    <Button className="secondary small" disabled={action.busy} onClick={() => action.run(async () => { await post(`${base}/plan/reopen`, { confirmed: true }); setConfirming(false); onChange(); })}>Yes, plan again</Button>
    <Button className="secondary small" onClick={() => setConfirming(false)}>Cancel</Button>
    <ErrorNotice error={action.error} />
  </div>;
}

export function InviteControl({ base }: { base: string }) {
  const [invite, setInvite] = useState<string>();
  const action = useAction();
  return <>
    <Button className="secondary" disabled={action.busy} onClick={() => action.run(async () => { const result = await post<{ inviteToken: string; inviteUrl?: string }>(`${base}/invites`); setInvite(result.inviteUrl ?? `${window.location.origin}/join/${segment(result.inviteToken)}`); })}>Invite someone</Button>
    {invite && <div className="notice"><div><label htmlFor="details-invite">Share this link</label><input id="details-invite" value={invite} readOnly onFocus={event => event.target.select()} /></div></div>}
    <ErrorNotice error={action.error} />
  </>;
}

export function stepSubtitle(room: Room) {
  if (room.trip) return `${room.trip.destination} · ${calendarDate(room.trip.checkIn)} – ${calendarDate(room.trip.checkOut)}`;
  const planning = room.planning;
  if (planning?.stage === 'VOTING') return 'Pick a trip';
  if (planning?.stage === 'DECIDED') return planning.message;
  if (planning) return `${planning.answered} of ${planning.total} have answered`;
  return `${room.readyMemberCount} of ${room.memberCount} have answered`;
}

function list(names: string[]) {
  if (names.length === 1) return names[0]!;
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(', ')}, and ${names.at(-1)}`;
}
