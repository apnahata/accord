import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { CalendarDays, CheckCheck, CreditCard, UserRound } from 'lucide-react';
import { Button, Empty, ErrorNotice, Loading, PageHeading, Tag } from './components';
import { date, dateTime, money, post, segment } from './api';
import { useAction, useResource } from './hooks';
import type { AccountDTO } from './contracts';

function GroupCard({ group }: { group: AccountDTO['groups'][number] }) {
  return <article className="panel account-trip"><div className="between"><Tag>{group.status.replaceAll('_', ' ').toLowerCase()}</Tag><span className="subtle">{group.role === 'HOST' ? 'Host' : 'Member'}</span></div><h3>{group.name}</h3>{group.trip && <p><CalendarDays size={15} /> {group.trip.destination} · {date(`${group.trip.checkIn}T12:00:00`)} – {date(`${group.trip.checkOut}T12:00:00`)}</p>}<p className="subtle">{group.readyMemberCount}/{group.memberCount} members ready</p>{group.booking && <div className="booking-history"><CheckCheck size={18} /><div><strong>{group.booking.propertyName}</strong><span>{group.booking.city} · {money(group.booking.totalCents)} total</span><span>Your contribution: {money(group.booking.ownContributionCents)} · {group.booking.paymentStatus.toLowerCase()}</span><small>Confirmation {group.booking.reference}</small></div></div>}<div className="button-row"><Link className="text-button" to={`/rooms/${segment(group.roomId)}`}>{group.booking ? 'Open group' : 'Continue planning'}</Link>{group.booking && <Link className="text-button" to={`/rooms/${segment(group.roomId)}/receipt`}>View receipt</Link>}</div></article>;
}

export function Account() {
  const resource = useResource<AccountDTO>('/me');
  const action = useAction();
  const [editing, setEditing] = useState(false);
  const legacyProfile = resource.data && !resource.data.user.email ? resource.data : undefined;
  const account = resource.data?.user.email ? resource.data : undefined;
  const active = account?.groups.filter(group => group.status !== 'BOOKED') ?? [];
  const booked = account?.groups.filter(group => group.status === 'BOOKED') ?? [];
  function updateProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const displayName = String(new FormData(event.currentTarget).get('displayName') || '').trim();
    void action.run(async () => { await post('/me/profile', { displayName }); setEditing(false); resource.refresh(); });
  }
  return <div className="page"><PageHeading eyebrow="Your dashboard" title={account ? `Welcome back, ${account.user.displayName}.` : 'Your trips, agreements, and receipts.'} description="Continue an active group, start a new one, or revisit a completed booking." />
    {resource.loading && !account && <Loading />}
    {!resource.loading && !account && <section className="panel"><h2>{legacyProfile ? 'Finish setting up your account' : 'Sign in to continue'}</h2><p>{legacyProfile ? `${legacyProfile.user.displayName} is a temporary browser-only profile. Add login credentials to keep its existing groups, or sign in to another account.` : 'Your groups and receipts follow your account across browsers and devices.'}</p><Link className="button" to="/auth?next=%2Fme">{legacyProfile ? 'Secure this profile or sign in' : 'Create an account or sign in'}</Link></section>}
    {account && <>
      <div className="dashboard-actions"><Link to="/rooms/new" className="button">Create a group</Link><Link to="/join" className="button secondary">Join with an invite</Link></div>
      <div className="account-heading"><div><p className="eyebrow">In progress</p><h2>Active groups</h2></div></div>
      {active.length ? <div className="account-grid">{active.map(group => <GroupCard key={group.roomId} group={group} />)}</div> : <Empty title="No active groups.">Create a group or join one from an invitation.</Empty>}
      <div className="account-heading"><div><p className="eyebrow">Completed</p><h2>Bookings and receipts</h2></div></div>
      {booked.length ? <div className="account-grid">{booked.map(group => <GroupCard key={group.roomId} group={group} />)}</div> : <Empty title="No completed bookings yet.">Confirmed bookings and their shared receipts will appear here.</Empty>}
      <div className="account-heading"><div><p className="eyebrow">Private to you</p><h2>Payment activity</h2></div></div>
      {account.payments.length ? <section className="panel"><div className="payment-history">{account.payments.map((payment, index) => <article key={`${payment.proposalId}-${payment.status}-${index}`}><span className="icon-circle"><CreditCard size={18} /></span><div><strong>{payment.label}</strong><span>{payment.propertyName} · {payment.roomName} · Proposal v{payment.proposalVersion}</span><small>{payment.scope === 'SHARED_PAYMENT' ? 'Your allocation in the shared group transaction' : 'Your private contribution commitment'} · {dateTime(payment.recordedAt)}{payment.transactionId ? ` · Reference ${payment.transactionId}` : ''}</small></div><div className="payment-amount"><strong>{money(payment.amountCents)}</strong><Tag>{payment.status.toLowerCase()}</Tag></div></article>)}</div></section> : <Empty title="No payment activity yet.">Contribution commitments, the shared authorization, capture, and any reversal will appear here.</Empty>}
      <details className="panel account-settings"><summary><UserRound size={18} /> Account settings</summary><p className="subtle">Signed in as {account.user.email}</p>{editing ? <form onSubmit={updateProfile}><label htmlFor="profile-name">Display name</label><input id="profile-name" name="displayName" required maxLength={60} defaultValue={account.user.displayName} /><div className="button-row"><Button disabled={action.busy}>Save</Button><Button type="button" className="secondary" onClick={() => setEditing(false)}>Cancel</Button></div></form> : <Button className="secondary" onClick={() => setEditing(true)}>Edit display name</Button>}<ErrorNotice error={action.error} /></details>
    </>}
  </div>;
}
