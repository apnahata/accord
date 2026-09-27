import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, ArrowRight, Check, Sparkles } from 'lucide-react';
import { Button, ErrorNotice, Loading } from './components';
import { money, post, segment } from './api';
import { useAction, useResource } from './hooks';
import type { Capabilities, Constraints } from './contracts';
import { Voice } from './pages-private';
import { dayRange, styleLabels } from './planning';

type ConversationMessage = { role: 'user' | 'assistant'; content: string };
type IntakeReply = { stage: 'CLARIFYING' | 'REVIEW'; reply: string; constraints?: Constraints; requiresConfirmation?: boolean; notChecked?: string[] };
const greeting = 'Hey. Glad you’re here. What kind of trip sounds good?';

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

export function TripChat({ roomPath, onSaved }: { roomPath: string; onSaved: () => void }) {
  const capabilities = useResource<Capabilities>('/capabilities');
  const action = useAction();
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [input, setInput] = useState('');
  const [draft, setDraft] = useState<Constraints>();
  const [leftOut, setLeftOut] = useState<string[]>([]);
  const [voiceError, setVoiceError] = useState<Error>();
  const [rememberPrompts, setRememberPrompts] = useState<MemoryPreference[]>();
  const [rememberedIds, setRememberedIds] = useState<Set<MemoryPreference>>(new Set());
  const log = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLFormElement>(null);
  useEffect(() => {
    const node = log.current;
    if (node) node.scrollTop = node.scrollHeight;
    composer.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [messages, action.busy]);

  async function send(value: string) {
    const content = value.trim();
    if (!content || action.busy) return;
    await action.run(async () => {
      const next: ConversationMessage[] = [...messages, { role: 'user', content }];
      const result = await post<IntakeReply>(roomPath + '/me/intake/extract', { messages: next });
      if (result.stage === 'REVIEW') {
        if (!result.constraints) throw new Error('Accord did not return a draft.');
        setDraft(result.constraints);
        setLeftOut(result.notChecked ?? []);
      }
      setMessages([...next, { role: 'assistant', content: result.reply }]);
      setInput('');
    });
  }

  function save(constraints: Constraints) {
    return action.run(async () => {
      await post(roomPath + '/me/constraints', { ...constraints, confirmed: true });
      const matches = capabilities.data?.backboard.available ? matchMemoryPreferences(constraints) : [];
      if (matches.length) setRememberPrompts(matches);
      else onSaved();
    });
  }

  if (capabilities.loading && !messages.length) return <Loading />;
  if (rememberPrompts) return <section className="step-card">
    <p className="step-from"><Sparkles size={14} />Accord</p>
    <h2>Should Accord remember any of this?</h2>
    <ul className="memory-list">{rememberPrompts.map(preference => <li key={preference}>
      <div><strong>Remember {MEMORY_PROMPT_LABELS[preference]} for future trips?</strong></div>
      {rememberedIds.has(preference)
        ? <Check size={19} />
        : <div className="button-row"><Button className="secondary small" disabled={action.busy} onClick={() => action.run(async () => {
            await post(roomPath + '/me/memories', { preference, confirmed: true });
            setRememberedIds(previous => new Set(previous).add(preference));
          })}>Remember</Button>
          <Button className="secondary small" onClick={() => setRememberPrompts(previous => previous?.filter(item => item !== preference))}>Not this trip</Button>
        </div>}
    </li>)}</ul>
    <div className="step-action"><Button onClick={onSaved}>Continue<ArrowRight size={16} /></Button></div>
    <ErrorNotice error={action.error} />
  </section>;
  if (draft) return <section className="step-card">
    <div className="conversation-log" aria-live="polite">
      <div className="conversation-message"><strong>Accord</strong><p>Here’s what I heard. {heard(draft)}</p></div>
    </div>
    {leftOut.length > 0 && <p className="subtle">I can’t check {leftOut.join('; ')}.</p>}
    <div className="step-action">
      <Button disabled={action.busy} onClick={() => save(draft)}>{action.busy ? 'Saving…' : 'Save'}<Check size={17} /></Button>
      <Button className="secondary" onClick={() => setDraft(undefined)}>Keep talking</Button>
    </div>
    <ErrorNotice error={action.error} />
  </section>;
  return <section className="step-card trip-chat">
    <div className="conversation-log" ref={log} aria-live="polite">
      <div className="conversation-message"><strong>Accord</strong><p>{greeting}</p></div>
      {messages.map((item, index) => <div className={'conversation-message ' + item.role} key={index}><strong>{item.role === 'user' ? 'You' : 'Accord'}</strong><p>{item.content}</p></div>)}
      {action.busy && <p className="conversation-working">One moment…</p>}
    </div>
    <form className="conversation-compose" ref={composer} onSubmit={event => { event.preventDefault(); void send(input); }}>
      <label className="sr-only" htmlFor="private-conversation">Your answer</label>
      <textarea id="private-conversation" value={input} onChange={event => setInput(event.target.value)} maxLength={1000} rows={1} placeholder={messages.length ? '' : 'A beach weekend…'} autoFocus />
      <div className="step-action">
        <Button disabled={!input.trim() || action.busy}>{action.busy ? 'Thinking…' : 'Send'}<ArrowRight size={16} /></Button>
        {messages.length > 0 && <Button type="button" className="secondary" disabled={action.busy} onClick={() => void send("That's all")}>That’s all</Button>}
        {capabilities.data?.elevenLabs.available && !!navigator.mediaDevices && typeof MediaRecorder !== 'undefined' && <Voice onTranscript={transcript => void send(transcript)} onError={setVoiceError} />}
      </div>
    </form>
    <ErrorNotice error={action.error} />
    <ErrorNotice error={voiceError} />
  </section>;
}

export function Intake() {
  const { roomId = '' } = useParams();
  const path = '/rooms/' + segment(roomId);
  const navigate = useNavigate();
  return <div className="page step-room">
    <Link to={path} className="back-link"><ArrowLeft size={15} />Back</Link>
    <TripChat roomPath={path} onSaved={() => navigate(path)} />
  </div>;
}

function heard(constraints: Constraints) {
  const parts = [`up to ${money(constraints.maxContributionCents)}`];
  if (constraints.availability?.length) parts.push(constraints.availability.map(range => `free ${dayRange(range.from, range.to)}`).join(' or '));
  if (constraints.nights) parts.push(`about ${constraints.nights} ${constraints.nights === 1 ? 'night' : 'nights'}`);
  if (constraints.leavingFrom) parts.push(`leaving from ${constraints.leavingFrom}`);
  if (constraints.tripStyles?.length) parts.push(`a ${constraints.tripStyles.map(style => styleLabels[style].toLowerCase()).join(' and ')} trip`);
  if (constraints.placeIdeas) parts.push(`you’d love ${constraints.placeIdeas}`);
  if (constraints.placesToAvoid) parts.push(`skipping ${constraints.placesToAvoid}`);
  if (constraints.requiresFullCashRefund) parts.push('a full refund');
  if (constraints.requiresStepFreeAccess) parts.push('step-free access');
  if (constraints.softPreference) parts.push(constraints.softPreference);
  const sentence = parts.join(', ');
  return sentence.charAt(0).toUpperCase() + sentence.slice(1) + '.';
}
