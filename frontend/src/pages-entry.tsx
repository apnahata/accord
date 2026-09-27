import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowRight, Check, LockKeyhole, ShieldCheck, Sparkles, Users } from 'lucide-react';
import { Button, ErrorNotice, LinkButton, Loading, PageHeading, StayArt } from './components';
import { post, segment } from './api';
import { useAction, useResource } from './hooks';
import type { AccountDTO, Capabilities } from './contracts';

export function Landing() {
  const steps = [
    { icon: LockKeyhole, n: '01', title: 'Answer privately', text: 'Budget, dates, and the kind of trip you want.' },
    { icon: Sparkles, n: '02', title: 'Accord finds a trip', text: 'Your group picks from the stays that work for everyone.' },
    { icon: ShieldCheck, n: '03', title: 'Everyone says yes', text: 'Then Accord books it.' },
  ];
  return <div className="landing">
    <section className="hero">
      <div className="hero-copy"><p className="eyebrow"><span className="tiny-star">✳</span> Find your common ground</p><h1>Plan together.<br />Pay together.<br /><em>Keep your boundaries private.</em></h1><p className="hero-tagline">Name a trip. Invite your friends. Accord does the rest.</p><div className="hero-actions"><LinkButton to="/rooms/new">Start a trip</LinkButton></div></div>
      <div className="hero-visual"><div className="visual-heading"><span>THE NEXT CHAPTER</span><span>TOGETHER, ON YOUR TERMS ↗</span></div><StayArt city="Miami" large /><div className="floating-note note-private"><span className="icon-circle"><LockKeyhole size={18} /></span><div><strong>A space for your boundaries</strong><span>Only you and Accord.</span></div></div><div className="agreement-card"><div className="avatar-flow" aria-hidden="true"><span>A</span><span>P</span><span>J</span><span>M</span><i /><span className="agreement-check"><Check size={20} /></span></div><div><strong>Four people. One common ground.</strong><p>Everyone gets a say. Everyone stays themselves.</p></div><span className="illustrative">An illustration of agreement</span></div></div>
    </section>
    <section id="how-it-works" className="how-section"><div><p className="eyebrow">Less back-and-forth. More looking forward.</p><h2>Good together.<br /><em>Right for each of you.</em></h2></div><div className="how-grid">{steps.map(item => <article key={item.n}><div className="between"><item.icon size={23} strokeWidth={1.5} /><span>{item.n}</span></div><h3>{item.title}</h3><p>{item.text}</p></article>)}</div></section>
    <section className="closing-note"><span className="tiny-star">✳</span><p>A great trip starts with a plan<br /><em>everyone can feel good about.</em></p><Link to="/rooms/new" className="text-button">Let’s bring it together <ArrowRight size={18} /></Link></section>
  </div>;
}

type CreatedRoom = { roomId: string; inviteToken: string; inviteUrl?: string };
export function NewRoom() {
  const [created, setCreated] = useState<CreatedRoom>();
  const action = useAction();
  const [copied, setCopied] = useState(false);
  const account = useResource<AccountDTO>('/me');
  const capabilities = useResource<Capabilities>('/capabilities');
  const signedIn = account.data?.user.email ? account.data : undefined;
  const invite = created ? created.inviteUrl || `${window.location.origin}/join/${segment(created.inviteToken)}` : '';
  if (!created && (account.loading || capabilities.loading)) return <div className="page step-room"><Loading /></div>;
  if (!created && !signedIn) return <div className="page step-room"><header className="step-head"><h1>Sign in first.</h1></header><LinkButton to="/auth?next=%2Frooms%2Fnew">Sign in</LinkButton></div>;
  if (created) return <div className="page step-room">
    <header className="step-head"><h1>Send this to your friends.</h1></header>
    <section className="step-card">
      <label htmlFor="invite-link">Invite link</label>
      <div className="copy-field"><input id="invite-link" readOnly value={invite} /><Button className="secondary" onClick={() => action.run(async () => { await navigator.clipboard.writeText(invite); setCopied(true); })}>{copied ? 'Copied' : 'Copy'}</Button></div>
      <div className="step-action"><LinkButton to={`/rooms/${segment(created.roomId)}`}>Open the trip</LinkButton></div>
    </section>
  </div>;
  return <div className="page step-room">
    <header className="step-head"><h1>Name the trip.</h1></header>
    <form className="step-card form-panel" onSubmit={event => { event.preventDefault(); const name = new FormData(event.currentTarget).get('name'); action.run(async () => setCreated(await post<CreatedRoom>('/rooms', { name, plan: {}, rehearsal: !capabilities.data?.liveSearch.available }))); }}>
      <label htmlFor="room-name">Trip name</label>
      <input id="room-name" name="name" maxLength={100} required placeholder="Friends trip" autoFocus />
      <div className="step-action"><Button disabled={action.busy}>{action.busy ? 'Creating…' : 'Create the trip'}<ArrowRight size={17} /></Button></div>
      <ErrorNotice error={action.error} />
    </form>
  </div>;
}

export function JoinEntry() {
  const navigate = useNavigate();
  const [error, setError] = useState<Error>();
  return <div className="page step-room">
    <header className="step-head"><h1>Paste the invite link.</h1></header>
    <form className="step-card form-panel" onSubmit={event => { event.preventDefault(); setError(undefined); const value = String(new FormData(event.currentTarget).get('invite')).trim(); try { const url = new URL(value, window.location.origin); if (url.origin !== window.location.origin || !/^\/join\/[^/]+\/?$/.test(url.pathname)) throw new Error(); navigate(url.pathname); } catch { setError(new Error('That link isn’t an Accord invite.')); } }}>
      <label htmlFor="invite">Invite link</label>
      <input id="invite" name="invite" type="url" required placeholder="https://" />
      <Button>Continue <ArrowRight size={17} /></Button>
      <ErrorNotice error={error} />
    </form>
  </div>;
}

export function JoinRoom() {
  const { inviteToken = '' } = useParams();
  const resource = useResource<{ name: string; goal: string; memberCount: number }>(`/invites/${segment(inviteToken)}`);
  const navigate = useNavigate();
  const action = useAction();
  const account = useResource<AccountDTO>('/me');
  const signedIn = account.data?.user.email ? account.data : undefined;
  if (account.loading) return <div className="page step-room"><Loading /></div>;
  if (!signedIn) return <div className="page step-room">
    <header className="step-head"><h1>{resource.data?.name || 'Join this trip.'}</h1></header>
    <section className="step-card"><div className="step-action"><LinkButton to={`/auth?next=${encodeURIComponent(`/join/${inviteToken}`)}`}>Sign in</LinkButton></div></section>
    <ErrorNotice error={resource.error} />
  </div>;
  return <div className="page step-room">
    <header className="step-head"><h1>{resource.data?.name || 'Join this trip.'}</h1>{resource.loading && <Loading />}</header>
    <ErrorNotice error={resource.error} retry={resource.refresh} />
    {resource.data && <section className="step-card">
      <p>Answer a few things in private, then Accord takes it from there.</p>
      <div className="step-action"><Button disabled={action.busy} onClick={() => action.run(async () => { const result = await post<{ roomId: string }>(`/invites/${segment(inviteToken)}/join`); navigate(`/rooms/${segment(result.roomId)}/me/intake`); })}>{action.busy ? 'Joining…' : `Join as ${signedIn.user.displayName}`}<ArrowRight size={17} /></Button></div>
    </section>}
    <ErrorNotice error={action.error} />
  </div>;
}
