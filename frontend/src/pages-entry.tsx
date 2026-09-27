import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowRight, Check, CheckCheck, Copy, LockKeyhole, ShieldCheck, Sparkles, Users } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { Button, Empty, ErrorNotice, LinkButton, Loading, PageHeading, PrivateNote, StayArt, Tag } from './components';
import { post, segment } from './api';
import { useAction, useResource } from './hooks';
import type { AccountDTO, Capabilities } from './contracts';

export function Landing() {
  const steps = [
    { icon: LockKeyhole, n: '01', title: 'Tell Accord privately', text: 'Your budget, your needs, your non-negotiables. Share what matters, without explaining why.' },
    { icon: Sparkles, n: '02', title: 'Find the shared yes', text: 'Accord checks the options against everyone’s confirmed requirements. Your group sees the possibilities.' },
    { icon: ShieldCheck, n: '03', title: 'Approve the exact plan', text: 'Everyone approves an exact contribution. Accord then funds one shared group payment; changed terms always require fresh approval.' },
  ];
  return <div className="landing">
    <section className="hero">
      <div className="hero-copy"><p className="eyebrow"><span className="tiny-star">✳</span> Find your common ground</p><h1>Plan together.<br />Pay together.<br /><em>Keep your boundaries private.</em></h1><p className="hero-tagline">Good plans make room for everyone.</p><p className="hero-description">Accord privately understands what works for everyone, finds a shared option, and makes sure the group only purchases the exact offer everyone approved.</p><div className="hero-actions"><LinkButton to="/rooms/new">Create a group</LinkButton><LinkButton to="/join" secondary>Join a group</LinkButton></div><p className="hero-footnote"><LockKeyhole size={14} /> Your limits don’t need an explanation.</p></div>
      <div className="hero-visual"><div className="visual-heading"><span>THE NEXT CHAPTER</span><span>TOGETHER, ON YOUR TERMS ↗</span></div><StayArt city="Miami" large /><div className="floating-note note-private"><span className="icon-circle"><LockKeyhole size={18} /></span><div><strong>A space for your boundaries</strong><span>Only you and Accord.</span></div></div><div className="agreement-card"><div className="avatar-flow" aria-hidden="true"><span>A</span><span>P</span><span>J</span><span>M</span><i /><span className="agreement-check"><Check size={20} /></span></div><div><strong>Four people. One common ground.</strong><p>Everyone gets a say. Everyone stays themselves.</p></div><span className="illustrative">An illustration of agreement</span></div></div>
    </section>
    <section id="how-it-works" className="how-section"><div><p className="eyebrow">Less back-and-forth. More looking forward.</p><h2>Good together.<br /><em>Right for each of you.</em></h2></div><div className="how-grid">{steps.map(item => <article key={item.n}><div className="between"><item.icon size={23} strokeWidth={1.5} /><span>{item.n}</span></div><h3>{item.title}</h3><p>{item.text}</p></article>)}</div></section>
    <section className="closing-note"><span className="tiny-star">✳</span><p>A great trip starts with a plan<br /><em>everyone can feel good about.</em></p><Link to="/rooms/new" className="text-button">Let’s bring it together <ArrowRight size={18} /></Link></section>
  </div>;
}

type CreatedRoom = { roomId: string; inviteToken: string; inviteUrl?: string };
const isoDay = (offsetDays: number) => { const date = new Date(Date.now() + offsetDays * 86_400_000); return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
export function NewRoom() {
  const [created, setCreated] = useState<CreatedRoom>();
  const action = useAction();
  const [copied, setCopied] = useState(false);
  const account = useResource<AccountDTO>('/me');
  const capabilities = useResource<Capabilities>('/capabilities');
  const [rehearsalChoice, setRehearsalChoice] = useState<boolean>();
  const [mode, setMode] = useState<'plan' | 'known'>('plan');
  const signedIn = account.data?.user.email ? account.data : undefined;
  const rehearsal = rehearsalChoice ?? (capabilities.data ? !capabilities.data.liveSearch.available : false);
  const roomBody = (data: FormData) => {
    const name = data.get('name');
    if (mode === 'plan') return { name, rehearsal, plan: {} };
    return rehearsal
      ? { name, goal: 'A shared stay for the group, chosen from Accord’s controlled rehearsal stays.' }
      : { name, trip: { destination: String(data.get('destination')).trim(), checkIn: data.get('checkIn'), checkOut: data.get('checkOut'), guests: Number(data.get('guests')) } };
  };
  const invite = created ? created.inviteUrl || `${window.location.origin}/join/${segment(created.inviteToken)}` : '';
  if (!created && account.loading) return <div className="page narrow"><Loading /></div>;
  if (!created && !signedIn) return <div className="page narrow"><PageHeading eyebrow="Your Accord account" title="Sign in before creating a group." description={account.data ? `${account.data.user.displayName} is an older browser-only profile, not a signed-in account. Add credentials or sign in so your groups and receipts persist.` : 'This keeps the group, booking, approvals, and receipts attached to you—not to one browser window.'} /><section className="panel"><LinkButton to="/auth?next=%2Frooms%2Fnew">Create an account or sign in</LinkButton></section></div>;
  return <div className="page narrow"><PageHeading eyebrow="A little planning, a lot of possibility" title={created ? 'Make room for everyone.' : 'Bring your people together.'} description={created ? 'Share this invitation. Each friend signs in and joins with their own account.' : 'Start with a shared goal. Everyone’s personal boundaries come next, privately.'} />{created ? <section className="panel invite-panel"><Tag><Users size={14} />Your group is ready for company</Tag><div className="qr"><QRCodeSVG value={invite} size={164} level="M" title="Scan to join this Accord group" /></div><label htmlFor="invite-link">Your invite link</label><div className="copy-field"><input id="invite-link" readOnly value={invite} /><Button className="secondary" onClick={() => action.run(async () => { await navigator.clipboard.writeText(invite); setCopied(true); })}>{copied ? <Check size={17} /> : <Copy size={17} />}<span>{copied ? 'Copied' : 'Copy'}</span></Button></div><PrivateNote /><LinkButton to={`/rooms/${segment(created.roomId)}`}>Go to your waiting room</LinkButton><Link className="text-button" to={`/rooms/${segment(created.roomId)}/me/intake`}>Set your private requirements <ArrowRight size={16} /></Link></section> : <form key={account.data?.user.id} className="panel form-panel" onSubmit={event => { event.preventDefault(); const data = new FormData(event.currentTarget); action.run(async () => setCreated(await post<CreatedRoom>('/rooms', roomBody(data)))); }}><label htmlFor="room-name">Give your group a name</label><input id="room-name" name="name" maxLength={100} required placeholder="Spring break stay" /><div className="segmented mode-switch" role="group" aria-label="How much is decided"><button type="button" aria-pressed={mode === 'plan'} onClick={() => setMode('plan')}>Help us decide where and when</button><button type="button" aria-pressed={mode === 'known'} onClick={() => setMode('known')}>We know where and when</button></div><label className="checkbox-row"><input type="checkbox" checked={rehearsal} onChange={event => setRehearsalChoice(event.target.checked)} /><span>{mode === 'plan' ? 'Use Accord’s rehearsal stays (generated for any destination and dates, so planning plays out without live providers)' : 'Use Accord’s controlled rehearsal stays instead of live provider inventory'}</span></label>{mode === 'plan' && <p className="field-help">That’s all you need. Everyone, you included, privately tells Accord when they’re free, how long they’d like to go, where they’re leaving from, what kind of trip they want, and what they can spend. Accord works out when and where, checks stays, and the group votes on a shortlist.</p>}{mode === 'known' && !rehearsal && <><label htmlFor="destination">Where are you going?</label><input id="destination" name="destination" required minLength={2} maxLength={120} placeholder="Miami, FL" /><p className="field-help">Accord searches live hotels for the exact dates you choose below.</p><div className="trip-fields"><div><label htmlFor="check-in">Check-in</label><input id="check-in" name="checkIn" type="date" required min={isoDay(1)} /></div><div><label htmlFor="check-out">Check-out</label><input id="check-out" name="checkOut" type="date" required min={isoDay(2)} /></div><div><label htmlFor="guests">Guests</label><input id="guests" name="guests" type="number" required min={1} max={8} defaultValue={4} /></div></div><p className="field-help">These are the group’s booking dates. Individual members can leave their personal date preferences blank.</p></>}<PrivateNote /><Button disabled={action.busy}>{action.busy ? 'Creating your group…' : `Create group as ${account.data?.user.displayName}`}<ArrowRight size={17} /></Button><p className="fine">Creating a group doesn’t authorize any payment.</p></form>}<ErrorNotice error={action.error} /><ErrorNotice error={capabilities.error} /></div>;
}

export function JoinEntry() {
  const navigate = useNavigate();
  const [error, setError] = useState<Error>();
  return <div className="page narrow"><PageHeading eyebrow="There’s a place for you" title="Meet your group here." description="Paste the invitation your friend shared with you." /><form className="panel form-panel" onSubmit={event => { event.preventDefault(); setError(undefined); const value = String(new FormData(event.currentTarget).get('invite')).trim(); try { const url = new URL(value, window.location.origin); if (url.origin !== window.location.origin || !/^\/join\/[^/]+\/?$/.test(url.pathname)) throw new Error(); navigate(url.pathname); } catch { setError(new Error('Enter a full Accord invite link from this site.')); } }}><label htmlFor="invite">Invitation link</label><input id="invite" name="invite" type="text" required placeholder={`${window.location.origin}/join/…`} /><Button>Find my group <ArrowRight size={17} /></Button><PrivateNote /></form><ErrorNotice error={error} /></div>;
}

export function JoinRoom() {
  const { inviteToken = '' } = useParams();
  const resource = useResource<{ name: string; goal: string; memberCount: number }>(`/invites/${segment(inviteToken)}`);
  const navigate = useNavigate();
  const action = useAction();
  const account = useResource<AccountDTO>('/me');
  const signedIn = account.data?.user.email ? account.data : undefined;
  if (account.loading) return <div className="page narrow"><Loading /></div>;
  if (!signedIn) return <div className="page narrow"><PageHeading eyebrow="An invitation to find common ground" title="Sign in to join your group." description={account.data ? `${account.data.user.displayName} is only a temporary browser profile. It has no login credentials, so Accord will not attach approvals or payments to it.` : 'Your private requirements, approvals, and payment records must belong to your own account.'} /><section className="panel"><LinkButton to={`/auth?next=${encodeURIComponent(`/join/${inviteToken}`)}`}>{account.data ? 'Secure this profile or sign in' : 'Create an account or sign in'}</LinkButton><p className="fine">After authentication, Accord returns you to this invitation automatically.</p></section><ErrorNotice error={resource.error} /></div>;
  return <div className="page narrow"><PageHeading eyebrow="An invitation to find common ground" title="Your people are planning something." />{resource.loading && <Loading />}<ErrorNotice error={resource.error} retry={resource.refresh} />{resource.data && <section className="panel form-panel"><Tag><Users size={14} />{resource.data.memberCount} joined</Tag><h2>{resource.data.name}</h2><p className="subtle">{resource.data.goal}</p><p>You’re signed in as <strong>{signedIn.user.displayName}</strong>. Your private requirements and approvals will stay attached to this account.</p><PrivateNote /><Button disabled={action.busy} onClick={() => action.run(async () => { const result = await post<{ roomId: string }>(`/invites/${segment(inviteToken)}/join`); navigate(`/rooms/${segment(result.roomId)}/me/intake`); })}>{action.busy ? 'Joining securely…' : `Join as ${signedIn.user.displayName}`}<LockKeyhole size={16} /></Button><p className="fine">You’ll review your own requirements and approve your own contribution.</p></section>}<ErrorNotice error={action.error} /></div>;
}
