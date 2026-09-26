import { useState } from 'react';
import { CalendarDays, Check, Compass, MapPin, Sparkles, Vote } from 'lucide-react';
import { Button, ErrorNotice, LinkButton, Loading, Tag } from './components';
import { money, post } from './api';
import { useAction } from './hooks';
import type { Availability, Constraints, PublicRoomDTO, TripPlan, TripStyle } from './contracts';

export const styleLabels: Record<TripStyle, string> = {
  BEACH: 'Beach', MOUNTAINS: 'Mountains', SKI: 'Ski', CITY: 'City', NATURE: 'Nature', THEME_PARKS: 'Theme parks', LAKE: 'Lake',
};
const styles = Object.keys(styleLabels) as TripStyle[];
const day = (value: string, withYear = false) => new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', ...(withYear ? { year: 'numeric' } : {}), timeZone: 'UTC' }).format(new Date(`${value}T12:00:00Z`));
export const dayRange = (from: string, to: string) => `${day(from)} – ${day(to, true)}`;
export const planSummary = (plan: TripPlan) => `${plan.nights} ${plan.nights === 1 ? 'night' : 'nights'} sometime between ${dayRange(plan.earliest, plan.latest)} · where to be decided together`;

type Planning = NonNullable<PublicRoomDTO['planning']>;

/** What Accord is considering, and the private vote. Everything shown is host-set or an anonymous total. */
export function PlanningBoard({ room, base, onChange, invite }: { room: PublicRoomDTO; base: string; onChange: () => void; invite: React.ReactNode }) {
  const planning = room.planning!;
  const action = useAction();
  const vote = (optionId: string) => action.run(async () => { await post(`${base}/plan/vote`, { optionId }); onChange(); });
  const title = { COLLECTING: 'Gathering everyone’s answers.', PLANNING: 'Working out where and when.', VOTING: 'Pick your favorite.', NO_OPTION: 'No shared plan just yet.', DECIDED: 'Your trip is decided.' }[planning.stage];
  return <section className="panel planning-board">
    <div className="section-heading"><p className="eyebrow"><Compass size={13} />Planning together</p>{planning.rehearsal && <Tag tone="warm">Rehearsal stays</Tag>}</div>
    <h2>{title}</h2>
    {planning.stage === 'COLLECTING' && <>
      <p>{planning.answered} of {planning.total} have answered. Each person privately tells Accord when they can go, what kind of trip they’d love, and what they can spend. Accord plans on its own once everyone has answered.</p>
      <div className="button-row">{room.members.find(member => member.isYou)?.ready
        ? <LinkButton to={`${base}/me/intake`} secondary>Review my answers</LinkButton>
        : <LinkButton to={`${base}/me/intake`}>Answer privately</LinkButton>}</div>
      {invite}
    </>}
    {planning.stage === 'PLANNING' && <><p>Accord is overlapping everyone’s dates, picking destinations, and checking stays against everyone’s requirements.</p><Loading /></>}
    {planning.stage === 'NO_OPTION' && <><p>{planning.message}</p><div className="button-row"><LinkButton to={`${base}/me/intake`} secondary>Review my answers</LinkButton></div></>}
    {planning.stage === 'VOTING' && <p>{planning.message}</p>}
    <PlanFacts planning={planning} />
    {planning.options.length > 0 && <div className="trip-options">{planning.options.map(option => {
      const mine = planning.myVoteOptionId === option.id, won = planning.decidedOptionId === option.id;
      return <article key={option.id} className={`trip-option ${mine ? 'mine' : ''} ${won ? 'won' : ''}`}>
        <p className="eyebrow"><MapPin size={13} />{option.destination}</p>
        <h3>{dayRange(option.checkIn, option.checkOut)} <small>{option.nights} nights</small></h3>
        <p className="subtle">{option.propertyName}</p>
        <div className="price-row"><div><strong>{money(option.equalShareCents)}</strong><span> / person</span></div><span>{money(option.totalCents)} total</span></div>
        <ul className="why-list">{option.why.map(reason => <li key={reason}><Check size={14} />{reason}</li>)}</ul>
        {option.votes !== undefined && <p className="vote-total"><Vote size={15} />{option.votes} {option.votes === 1 ? 'vote' : 'votes'}{won && ' · the group’s pick'}</p>}
        {planning.stage === 'VOTING' && (mine
          ? <p className="my-vote"><Check size={15} />Your vote</p>
          : <Button className={planning.myVoteOptionId ? 'secondary small' : 'small'} disabled={action.busy} onClick={() => vote(option.id)}>{planning.myVoteOptionId ? 'Change my vote to this' : 'Vote for this trip'}</Button>)}
      </article>;
    })}</div>}
    {planning.stage === 'VOTING' && <p className="fine">Accord picks the trip with the most votes once everyone has voted{planning.voteClosesAt ? `, or when voting closes ${new Date(planning.voteClosesAt).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' })}` : ''}. A tie goes to the trip that fits the group best. Vote totals appear when voting closes.</p>}
    <ErrorNotice error={action.error} />
  </section>;
}

function PlanFacts({ planning }: { planning: Planning }) {
  if (!planning.styles.length && !planning.windows.length && !planning.destinations.length) return null;
  return <dl className="plan-facts">
    {planning.styles.length > 0 && <div><dt>The group is in the mood for</dt><dd className="chip-row">{planning.styles.map(item => <span key={item.style} className="chip">{styleLabels[item.style]} <b>{item.count}</b></span>)}</dd></div>}
    {planning.windows.length > 0 && <div><dt><CalendarDays size={14} />Dates that work for everyone</dt><dd className="chip-row">{planning.windows.map(window => <span key={window.checkIn} className="chip">{dayRange(window.checkIn, window.checkOut)}</span>)}</dd></div>}
    {planning.destinations.length > 0 && <div><dt><Sparkles size={14} />Places Accord considered</dt><dd><ul className="considered">{planning.destinations.map(item => <li key={item.name}><strong>{item.name}</strong> {item.why}</li>)}</ul></dd></div>}
  </dl>;
}

/** Shown above the proposal once the group has picked a trip. */
export function DecidedTrip({ room, base, onChange }: { room: PublicRoomDTO; base: string; onChange: () => void }) {
  const planning = room.planning!, action = useAction();
  const winner = planning.options.find(option => option.id === planning.decidedOptionId);
  const [confirming, setConfirming] = useState(false);
  if (!winner) return null;
  const how = planning.decidedBy === 'ONLY_OPTION' ? 'The only trip that worked for everyone.' : `Picked by the group’s vote (${winner.votes ?? 0} of ${planning.total}).`;
  return <section className="panel decided-trip">
    <div className="section-heading"><p className="eyebrow"><Compass size={13} />Where and when</p><Tag><Check size={13} />Decided</Tag></div>
    <h3>{winner.destination} · {dayRange(winner.checkIn, winner.checkOut)}</h3>
    <p className="subtle">{how}{room.status !== 'BOOKED' && ' Accord now watches this trip’s stays and replans within it if anything changes.'}</p>
    {planning.options.length > 1 && <details><summary>See the shortlist</summary><PlanningResults planning={planning} /></details>}
    {room.viewerIsHost && room.status !== 'BOOKED' && (confirming
      ? <div className="button-row"><Button className="secondary small" disabled={action.busy} onClick={() => action.run(async () => { await post(`${base}/plan/reopen`, { confirmed: true }); setConfirming(false); onChange(); })}>Yes, plan again</Button><Button className="secondary small" onClick={() => setConfirming(false)}>Cancel</Button><span className="fine">Everyone’s approvals are cancelled, and Accord plans again with everyone’s current answers.</span></div>
      : <button className="text-button" onClick={() => setConfirming(true)}>Reopen planning</button>)}
    <ErrorNotice error={action.error} />
  </section>;
}
function PlanningResults({ planning }: { planning: Planning }) {
  return <ul className="considered">{planning.options.map(option => <li key={option.id}><strong>{option.destination}</strong> {dayRange(option.checkIn, option.checkOut)} · {money(option.equalShareCents)} each{option.votes !== undefined && ` · ${option.votes} ${option.votes === 1 ? 'vote' : 'votes'}`}</li>)}</ul>;
}

/** Trip-planning questions for the private intake form. Uncontrolled; read back with `readTripAnswers`. */
export function TripAnswerFields({ values, plan }: { values?: Constraints; plan: TripPlan }) {
  const [ranges, setRanges] = useState<Array<Partial<Availability>>>(values?.availability?.length ? values.availability : [{}]);
  return <>
    <hr />
    <div className="section-heading"><h2>Your trip wishes</h2><Compass size={20} /></div>
    <p className="subtle">The group is planning {plan.nights} nights between {dayRange(plan.earliest, plan.latest)}. Only anonymous totals are ever shown to the group.</p>
    <label>When could you go? <span>Optional</span></label>
    {ranges.map((range, index) => <div className="trip-fields availability-row" key={index}>
      <div><label htmlFor={`from-${index}`} className="sr-only">Earliest day you could leave</label><input id={`from-${index}`} name={`from-${index}`} type="date" min={plan.earliest} max={plan.latest} defaultValue={range.from} aria-label="Earliest day you could leave" /></div>
      <div><label htmlFor={`to-${index}`} className="sr-only">Latest day you could be back</label><input id={`to-${index}`} name={`to-${index}`} type="date" min={plan.earliest} max={plan.latest} defaultValue={range.to} aria-label="Latest day you could be back" /></div>
    </div>)}
    {ranges.length < 3 && <button type="button" className="text-button" onClick={() => setRanges([...ranges, {}])}>Add another stretch of dates</button>}
    <p className="field-help">From the earliest day you could leave to the latest day you could be back. Leave blank if any dates in the window work.</p>
    <label>What kind of trip would you love? <span>Pick any</span></label>
    <div className="chip-row style-picker">{styles.map(style => <label key={style} className="chip-toggle"><input type="checkbox" name="style" value={style} defaultChecked={values?.tripStyles?.includes(style)} /><span>{styleLabels[style]}</span></label>)}</div>
    <label htmlFor="place-ideas">Anywhere you’d love to go? <span>Optional</span></label>
    <input id="place-ideas" name="placeIdeas" maxLength={300} placeholder="Somewhere warm, Charleston, a lake town…" defaultValue={values?.placeIdeas || ''} />
    <label htmlFor="places-avoid">Anywhere you’d rather not go? <span>Optional</span></label>
    <input id="places-avoid" name="placesToAvoid" maxLength={300} placeholder="Not Florida again…" defaultValue={values?.placesToAvoid || ''} />
    <p className="field-help">Accord never suggests a place someone ruled out, and never says who ruled it out.</p>
  </>;
}
export function readTripAnswers(data: FormData): Partial<Constraints> {
  const availability: Availability[] = [];
  for (let index = 0; index < 3; index++) {
    const from = String(data.get(`from-${index}`) || ''), to = String(data.get(`to-${index}`) || '');
    if (from && to && to > from) availability.push({ from, to });
  }
  const tripStyles = data.getAll('style').map(String) as TripStyle[];
  const placeIdeas = String(data.get('placeIdeas') || '').trim(), placesToAvoid = String(data.get('placesToAvoid') || '').trim();
  return { ...(availability.length ? { availability } : {}), ...(tripStyles.length ? { tripStyles } : {}), ...(placeIdeas ? { placeIdeas } : {}), ...(placesToAvoid ? { placesToAvoid } : {}) };
}

/** Read-only view of a member's own trip answers. */
export function TripAnswerList({ constraints }: { constraints: Constraints }) {
  if (!constraints.availability?.length && !constraints.tripStyles?.length && !constraints.placeIdeas && !constraints.placesToAvoid) return null;
  return <dl className="boundary-list">
    <div><dt>When you can go</dt><dd>{constraints.availability?.length ? constraints.availability.map(range => dayRange(range.from, range.to)).join('; ') : 'Any dates in the window'}</dd></div>
    {!!constraints.tripStyles?.length && <div><dt>Trip styles</dt><dd>{constraints.tripStyles.map(style => styleLabels[style]).join(', ')}</dd></div>}
    {constraints.placeIdeas && <div><dt>Would love</dt><dd>{constraints.placeIdeas}</dd></div>}
    {constraints.placesToAvoid && <div><dt>Rather not</dt><dd>{constraints.placesToAvoid}</dd></div>}
  </dl>;
}
