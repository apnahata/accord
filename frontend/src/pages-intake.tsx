import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, ArrowRight, Check, LockKeyhole, Sparkles } from 'lucide-react';
import { Button, ErrorNotice, Loading, PageHeading, PrivateNote, Tag } from './components';
import { post, segment } from './api';
import { useAction, useResource } from './hooks';
import type { Capabilities, CapsuleDTO, Constraints, PublicRoomDTO } from './contracts';
import { BoundaryList, Voice } from './pages-private';
import { readTripAnswers, TripAnswerFields, TripAnswerList } from './planning';

type ConversationMessage = { role: 'user' | 'assistant'; content: string };
type MemoryPreference = 'WALKABLE' | 'QUIET' | 'NEAR_ACTIVITIES' | 'REFUNDABLE';
const MEMORY_PROMPT_LABELS: Record<MemoryPreference, string> = {
  WALKABLE: 'walkable neighborhoods', QUIET: 'quiet properties', NEAR_ACTIVITIES: 'staying near activities', REFUNDABLE: 'refundable options',
};
/** Best-effort match from what the member just confirmed. Never invents a preference they didn't state. */
function matchMemoryPreferences(constraints: Constraints): MemoryPreference[] {
  const text = (constraints.softPreference || '').toLowerCase();
  const matches: MemoryPreference[] = [];
  if (/\bwalk/.test(text)) matches.push('WALKABLE');
  if (/\bquiet|\bpeaceful|\bcalm/.test(text)) matches.push('QUIET');
  if (/\bactivit/.test(text)) matches.push('NEAR_ACTIVITIES');
  if (constraints.requiresFullCashRefund) matches.push('REFUNDABLE');
  return matches;
}
type IntakeReply = {
  stage: 'CLARIFYING' | 'REVIEW';
  reply: string;
  constraints?: Constraints;
  requiresConfirmation?: boolean;
  followUps?: string[];
  notChecked?: string[];
};

export function Intake() {
  const { roomId = '' } = useParams();
  const path = '/rooms/' + segment(roomId);
  const capsule = useResource<CapsuleDTO>(path + '/me/constraints');
  const capabilities = useResource<Capabilities>('/capabilities');
  const room = useResource<PublicRoomDTO>(path);
  const planning = room.data?.trip ? undefined : room.data?.planning;
  const action = useAction();
  const navigate = useNavigate();
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [input, setInput] = useState('');
  const [draft, setDraft] = useState<Constraints>();
  const [notes, setNotes] = useState<{ followUps: string[]; notChecked: string[] }>({ followUps: [], notChecked: [] });
  const [source, setSource] = useState<'ai' | 'structured'>('ai');
  const [edit, setEdit] = useState<Constraints>();
  const [forceManual, setForceManual] = useState(false);
  const [voiceError, setVoiceError] = useState<Error>();
  const [rememberPrompts, setRememberPrompts] = useState<MemoryPreference[]>();
  const [rememberedIds, setRememberedIds] = useState<Set<MemoryPreference>>(new Set());
  const values = edit || capsule.data?.constraints;
  const aiAvailable = capabilities.data?.ai.available === true;
  const backboardAvailable = capabilities.data?.backboard.available === true;

  async function send(value: string) {
    const content = value.trim();
    if (!content || action.busy || messages.length >= 24) return;
    await action.run(async () => {
      const next: ConversationMessage[] = [...messages, { role: 'user', content }];
      const result = await post<IntakeReply>(path + '/me/intake/extract', { messages: next });
      if (!result.reply || (result.stage !== 'CLARIFYING' && result.stage !== 'REVIEW')) throw new Error('Accord did not return a usable answer. Please try again.');
      if (result.stage === 'REVIEW') {
        if (!result.requiresConfirmation || !result.constraints) throw new Error('Accord did not return a draft for your confirmation.');
        setDraft(result.constraints);
        setNotes({ followUps: result.followUps ?? [], notChecked: result.notChecked ?? [] });
        setSource('ai');
      }
      setMessages([...next, { role: 'assistant', content: result.reply }]);
      setInput('');
    });
  }

  function submitManual(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const maximum = Number(data.get('maximum'));
    setDraft({
      maxContributionCents: Math.round(maximum * 100),
      earliestCheckInDate: String(data.get('earliestCheckInDate') || '') || undefined,
      latestCheckInDate: String(data.get('latestCheckInDate') || '') || undefined,
      latestCheckOutDate: String(data.get('latestCheckOutDate') || '') || undefined,
      requiresFullCashRefund: data.get('refund') === 'on',
      requiresStepFreeAccess: data.get('stepFree') === 'on',
      softPreference: String(data.get('preference') || ''),
      ...(planning ? readTripAnswers(data) : {}),
    });
    setNotes({ followUps: [], notChecked: [] });
    setSource('structured');
  }

  return <div className="page private-page narrow">
    <Link to={'/rooms/' + segment(roomId)} className="back-link"><ArrowLeft size={15} />Your group</Link>
    <PageHeading
      eyebrow="Just between you and Accord"
      title={draft ? 'Does this feel right?' : 'Tell Accord what matters to you.'}
      description={draft ? 'Nothing is applied until you confirm. You never need to explain your reasons to the group.' : 'Speak naturally about your stay, your limit, and anything you need. Accord will ask if something needs clarification.'}
    />
    {capsule.loading && <Loading />}
    <ErrorNotice error={capsule.error} retry={capsule.refresh} />
    {capsule.data && (rememberPrompts ? <section className="panel confirmation">
      <Tag><Sparkles size={14} />Remember for next time</Tag>
      <h2>Should Accord remember any of this?</h2>
      <p className="subtle">These would carry over to your future trips. Nothing is saved unless you choose it.</p>
      <ul className="memory-list">
        {rememberPrompts.map(preference => <li key={preference}>
          <div><strong>Remember {MEMORY_PROMPT_LABELS[preference]} for future trips?</strong></div>
          {rememberedIds.has(preference)
            ? <Check size={19} />
            : <div className="button-row">
              <Button className="secondary small" disabled={action.busy} onClick={() => action.run(async () => {
                await post(path + '/me/memories', { preference, confirmed: true });
                setRememberedIds(previous => new Set(previous).add(preference));
              })}>Remember</Button>
              <Button className="secondary small" onClick={() => setRememberPrompts(previous => previous?.filter(item => item !== preference))}>Not this trip</Button>
            </div>}
        </li>)}
      </ul>
      <ErrorNotice error={action.error} />
      <Button onClick={() => navigate(path + '/me/summary')}>Continue<ArrowRight size={17} /></Button>
    </section> : draft ? <section className="panel confirmation">
      <Tag><Sparkles size={14} />{source === 'ai' ? 'Accord’s draft' : 'Ready for your confirmation'}</Tag>
      <h2>Your boundaries, in your words.</h2>
      <BoundaryList constraints={draft} />
      <TripAnswerList constraints={draft} />
      <h3>Your preference</h3>
      <p>{draft.softPreference || 'No preference added'}</p>
      {source === 'ai' && notes.notChecked.length > 0 && <div className="notice intake-note"><div><strong>Not included in this draft</strong><p>Accord books stays only, so it can’t check these: {notes.notChecked.join('; ')}.</p></div></div>}
      {source === 'ai' && notes.followUps.length > 0 && <div className="notice intake-note"><div><strong>Optional: you could also tell Accord</strong><ul>{notes.followUps.map(question => <li key={question}>{question}</li>)}</ul><p>Choose “Keep talking” to answer, or confirm as is.</p></div></div>}
      <PrivateNote />
      <p className="fine">These are planning requirements, not permission to spend. You will authorize an exact proposal separately.</p>
      <div className="button-row">
        <Button disabled={action.busy} onClick={() => action.run(async () => {
          await post(path + '/me/constraints', { ...draft, confirmed: true });
          const matches = backboardAvailable ? matchMemoryPreferences(draft) : [];
          if (matches.length) setRememberPrompts(matches);
          else navigate(path + '/me/summary');
        })}>{action.busy ? 'Saving privately…' : 'Confirm my requirements'}<Check size={17} /></Button>
        {source === 'ai' && <Button className="secondary" onClick={() => setDraft(undefined)}>Keep talking</Button>}
        <Button className="secondary" onClick={() => { setEdit(draft); setForceManual(true); setDraft(undefined); }}>Edit details</Button>
      </div>
    </section> : <>
      <section className="panel conversation-panel">
        <div className="section-heading"><h2><Sparkles size={20} /> Talk it through</h2><Tag>Private</Tag></div>
        <p className="subtle">{planning
          ? 'For example: “I can spend up to $500. I’m free Nov 7–16 and would like about 4 nights, leaving from Boston. I’d love a beach or a mountain town. Anywhere but Florida.”'
          : 'For example: “I can spend up to $350 and need to leave by noon Sunday. I’d rather not say why.”'}</p>
        {aiAvailable ? <>
          <div className="conversation-log" aria-live="polite" aria-label="Private conversation with Accord">
            {messages.length === 0 && <p className="conversation-intro">Tell Accord what would make this stay work for you. It will ask for anything it needs to clarify.</p>}
            {messages.map((item, index) => <div className={'conversation-message ' + item.role} key={index}>
              <strong>{item.role === 'user' ? 'You' : 'Accord'}</strong><p>{item.content}</p>
            </div>)}
            {action.busy && <p className="conversation-working">Accord is considering your answer…</p>}
            {messages.length >= 24 && <p className="conversation-working">This conversation is full. Start a fresh one to continue.</p>}
          </div>
          <form className="conversation-compose" onSubmit={event => { event.preventDefault(); void send(input); }}>
            <label className="sr-only" htmlFor="private-conversation">Tell Accord what you need</label>
            <textarea id="private-conversation" value={input} onChange={event => setInput(event.target.value)} maxLength={1000} rows={3} placeholder={messages.length ? 'Answer Accord or tell it what changed…' : 'What should Accord know about this stay?'} />
            <div className="button-row">
              <Button disabled={!input.trim() || action.busy || messages.length >= 24}>{action.busy ? 'Thinking…' : 'Send privately'}<ArrowRight size={16} /></Button>
              {capabilities.data?.elevenLabs.available && !!navigator.mediaDevices && typeof MediaRecorder !== 'undefined' && <Voice onTranscript={transcript => void send(transcript)} onError={setVoiceError} />}
              {messages.length >= 24 && <Button type="button" className="secondary" onClick={() => { setMessages([]); setInput(''); }}>Start fresh</Button>}
            </div>
          </form>
          <p className="fine">Accord will show you its interpretation before saving anything. The model provider processes text you submit here.</p>
        </> : <p className="fine">Private AI conversation is unavailable until a model is connected. You can still enter and confirm your requirements below.</p>}
      </section>
      <details key={forceManual ? 'editing' : aiAvailable ? 'optional' : 'fallback'} className="manual-intake" open={forceManual || !aiAvailable}>
        <summary>{aiAvailable ? 'Enter or edit requirements manually' : 'Enter your requirements'}</summary>
        <form key={JSON.stringify(values)} className="panel form-panel" onSubmit={submitManual}>
          <div className="section-heading"><h2>Your non-negotiables</h2><LockKeyhole size={20} /></div>
          <p className="subtle">Accord will never quietly bend these to make an offer fit.</p>
          <label htmlFor="maximum">Maximum personal contribution <span>Required</span></label>
          <div className="money-input"><span>$</span><input id="maximum" name="maximum" type="number" inputMode="decimal" min="0" max="1000000" step="0.01" required placeholder="350" defaultValue={values ? values.maxContributionCents / 100 : ''} /></div>
          <p className="field-help">Your ceiling stays private. The group sees the equal share.</p>
          <label htmlFor="earliest-check-in-date">Earliest acceptable arrival date <span>Optional</span></label>
          <input id="earliest-check-in-date" name="earliestCheckInDate" type="date" defaultValue={values?.earliestCheckInDate || ''} />
          <label htmlFor="latest-check-in-date">Latest acceptable arrival date <span>Optional</span></label>
          <input id="latest-check-in-date" name="latestCheckInDate" type="date" defaultValue={values?.latestCheckInDate || ''} />
          <label htmlFor="latest-check-out-date">Latest acceptable departure date <span>Optional</span></label>
          <input id="latest-check-out-date" name="latestCheckOutDate" type="date" defaultValue={values?.latestCheckOutDate || ''} />
          <p className="field-help">Leave these blank if the group’s trip dates work for you. Accord will not infer arrival or checkout times.</p>
          <label className="checkbox-row"><input name="refund" type="checkbox" defaultChecked={values?.requiresFullCashRefund} /><span><strong>I need a full cash refund</strong><small>Travel credit does not meet this requirement.</small></span></label>
          <label className="checkbox-row"><input name="stepFree" type="checkbox" defaultChecked={values?.requiresStepFreeAccess} /><span><strong>I need verified step-free access</strong><small>Unknown evidence does not count.</small></span></label>
          <hr />
          <label htmlFor="preference">What would make the stay better? <span>Optional</span></label>
          <textarea id="preference" name="preference" maxLength={1000} rows={3} placeholder="A walkable neighborhood, somewhere quiet…" defaultValue={values?.softPreference || ''} />
          {planning && <TripAnswerFields values={values ?? undefined} horizon={planning.horizon} />}
          <Button>Review my requirements <ArrowRight size={17} /></Button>
        </form>
      </details>
    </>)}
    <ErrorNotice error={action.error} />
    <ErrorNotice error={voiceError} />
    <PrivateNote />
  </div>;
}
