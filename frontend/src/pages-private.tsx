import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, ArrowRight, Check, LockKeyhole, Mic, Sparkles, Square } from 'lucide-react';
import { Button, ErrorNotice, LinkButton, Loading, PageHeading, PrivateNote, Tag } from './components';
import { api, dateTime, money, post, segment } from './api';
import { useAction, useResource } from './hooks';
import type { Capabilities, CapsuleDTO, Constraints, MemoryDTO } from './contracts';

function BoundaryList({ constraints }: { constraints: Constraints }) {
  return <dl className="boundary-list"><div><dt>Maximum personal contribution</dt><dd>{money(constraints.maxContributionCents)}</dd></div>{constraints.latestCheckOutAt && <div><dt>Must check out by</dt><dd>{dateTime(constraints.latestCheckOutAt)}</dd></div>}<div><dt>Full cash refund</dt><dd>{constraints.requiresFullCashRefund ? 'Required' : 'Not set as a requirement'}</dd></div><div><dt>Verified step-free access</dt><dd>{constraints.requiresStepFreeAccess ? 'Required' : 'Not set as a requirement'}</dd></div></dl>;
}

function Voice({ onTranscript, onError }: { onTranscript: (text: string) => void; onError: (error: Error) => void }) {
  const [state, setState] = useState<'idle' | 'listening' | 'transcribing'>('idle');
  const recorder = useRef<MediaRecorder | undefined>(undefined);
  const stream = useRef<MediaStream | undefined>(undefined);
  const alive = useRef(true);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => { alive.current = true; return () => { alive.current = false; clearTimeout(timer.current); if (recorder.current?.state === 'recording') recorder.current.stop(); stream.current?.getTracks().forEach(track => track.stop()); }; }, []);
  async function record() {
    try {
      stream.current = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!alive.current) { stream.current.getTracks().forEach(track => track.stop()); return; }
      const instance = new MediaRecorder(stream.current);
      recorder.current = instance;
      const chunks: Blob[] = [];
      instance.ondataavailable = event => chunks.push(event.data);
      instance.onstop = async () => {
        clearTimeout(timer.current); stream.current?.getTracks().forEach(track => track.stop());
        if (!alive.current) return;
        setState('transcribing');
        try { const data = new FormData(); data.append('audio', new Blob(chunks, { type: instance.mimeType }), 'private-intake.webm'); const result = await api<{ transcript: string }>('/intake/transcribe', { method: 'POST', body: data }); if (alive.current) onTranscript(result.transcript); }
        catch (error) { if (alive.current) onError(error as Error); }
        finally { if (alive.current) setState('idle'); }
      };
      instance.start(); setState('listening'); timer.current = window.setTimeout(() => { if (instance.state === 'recording') instance.stop(); }, 60000);
    } catch { stream.current?.getTracks().forEach(track => track.stop()); onError(new Error('Microphone access isn’t available. You can type your requirements below.')); setState('idle'); }
  }
  return <Button type="button" className="secondary" disabled={state === 'transcribing'} onClick={() => state === 'listening' ? recorder.current?.stop() : void record()}>{state === 'listening' ? <Square size={16} /> : <Mic size={17} />}{state === 'listening' ? 'Listening… Finish recording' : state === 'transcribing' ? 'Transcribing…' : 'Tell Accord privately'}</Button>;
}

export function Intake() {
  const { roomId = '' } = useParams();
  const path = `/rooms/${segment(roomId)}`;
  const capsule = useResource<CapsuleDTO>(`${path}/me/constraints`);
  const capabilities = useResource<Capabilities>('/capabilities');
  const action = useAction();
  const navigate = useNavigate();
  const [draft, setDraft] = useState<Constraints>();
  const [source, setSource] = useState<'structured' | 'ai'>('structured');
  const [text, setText] = useState('');
  const [voiceError, setVoiceError] = useState<Error>();
  const [edit, setEdit] = useState<Constraints>();
  const values = edit || capsule.data?.constraints;
  async function understand(transcript: string) {
    setText(transcript);
    await action.run(async () => {
      const result = await post<{ constraints: Constraints; needsClarification?: string }>(`${path}/me/intake/extract`, { text: transcript });
      if (result.needsClarification) throw new Error(result.needsClarification);
      if (!result.constraints || !Number.isSafeInteger(result.constraints.maxContributionCents) || result.constraints.maxContributionCents < 0) throw new Error('Please add your maximum contribution in the structured form before confirming.');
      setSource('ai'); setDraft(result.constraints);
    });
  }
  return <div className="page private-page narrow"><Link to={`/rooms/${segment(roomId)}`} className="back-link"><ArrowLeft size={15} />Your group</Link><PageHeading eyebrow="Just between you and Accord" title={draft ? 'Does this feel right?' : 'Good plans start with you.'} description={draft ? 'Nothing is applied until you confirm. Your reasons never need to be part of the conversation.' : 'Tell us what works for you. We’ll find the common ground without sharing your boundaries.'} /><div className="intake-steps" aria-label="Your progress"><span className={!draft ? 'active' : ''}>01 · Your boundaries</span><i /><span className={draft ? 'active' : ''}>02 · Your confirmation</span></div>{capsule.loading && <Loading />}<ErrorNotice error={capsule.error} retry={capsule.refresh} />{capsule.data && (draft ? <section className="panel confirmation"><Tag><Sparkles size={14} />{source === 'ai' ? 'Accord understood' : 'Ready for your confirmation'}</Tag><h2>Your boundaries, in your words.</h2><BoundaryList constraints={draft} /><h3>Your preference</h3><p>{draft.softPreference || 'No preference added'}</p><PrivateNote /><p className="fine">These are planning requirements, not permission to spend. You’ll authorize an exact proposal separately.</p><div className="button-row"><Button disabled={action.busy} onClick={() => action.run(async () => { await post(`${path}/me/constraints`, { ...draft, confirmed: true }); navigate(`${path.replace('/api', '')}/me/summary`); })}>{action.busy ? 'Saving privately…' : 'Confirm my requirements'}<Check size={17} /></Button><Button disabled={action.busy} className="secondary" onClick={() => { setEdit(draft); setDraft(undefined); }}>Edit</Button></div></section> : <><form key={JSON.stringify(values)} className="panel form-panel" onSubmit={event => {
    event.preventDefault(); const data = new FormData(event.currentTarget); const max = Number(data.get('maximum'));
    const deadline = String(data.get('deadline') || '');
    setDraft({ maxContributionCents: Math.round(max * 100), latestCheckOutAt: deadline ? new Date(deadline).toISOString() : undefined, requiresFullCashRefund: data.get('refund') === 'on', requiresStepFreeAccess: data.get('stepFree') === 'on', softPreference: String(data.get('preference') || '') }); setSource('structured');
  }}><div className="section-heading"><h2>Your non-negotiables</h2><LockKeyhole size={20} /></div><p className="subtle">Accord won’t quietly bend these to make an offer fit.</p><label htmlFor="maximum">Maximum personal contribution <span>Required</span></label><div className="money-input"><span>$</span><input id="maximum" name="maximum" type="number" inputMode="decimal" min="0" max="1000000" step="0.01" required placeholder="350" defaultValue={values ? values.maxContributionCents / 100 : ''} /></div><p className="field-help">Your ceiling stays private. The group’s equal share is public.</p><label htmlFor="deadline">Latest checkout / departure <span>Optional</span></label><input id="deadline" name="deadline" type="datetime-local" defaultValue={values?.latestCheckOutAt ? localDateInput(values.latestCheckOutAt) : ''} /><p className="field-help">Enter in your device’s timezone: {Intl.DateTimeFormat().resolvedOptions().timeZone}. Review the Eastern Time equivalent before confirming.</p><label className="checkbox-row"><input name="refund" type="checkbox" defaultChecked={values?.requiresFullCashRefund} /><span><strong>I need a full cash refund</strong><small>Travel credit doesn’t meet this requirement.</small></span></label><label className="checkbox-row"><input name="stepFree" type="checkbox" defaultChecked={values?.requiresStepFreeAccess} /><span><strong>I need verified step-free access</strong><small>Unknown or missing evidence doesn’t count.</small></span></label><hr /><label htmlFor="preference">What would make the stay a little better? <span>Optional</span></label><textarea id="preference" name="preference" maxLength={1000} rows={3} placeholder="A walkable neighborhood, somewhere quiet…" defaultValue={values?.softPreference || ''} /><p className="field-help">A preference helps rank suitable stays. It won’t override a hard requirement.</p><Button>Review my requirements <ArrowRight size={17} /></Button></form><section className="panel ai-panel"><div className="section-heading"><h3><Sparkles size={18} /> Say it your way</h3><Tag>Optional</Tag></div><p className="subtle">“I need to leave by noon Sunday but I’d rather not explain why.”</p>{capabilities.data?.ai.available ? <><label className="sr-only" htmlFor="private-text">Tell Accord your private requirements</label><textarea id="private-text" value={text} onChange={event => setText(event.target.value)} placeholder="What should Accord understand? Include your maximum contribution." rows={4} maxLength={4000} /><div className="button-row"><Button className="secondary" disabled={!text.trim() || action.busy} onClick={() => void understand(text)}>{action.busy ? 'Understanding…' : 'Help me put it into words'}<Sparkles size={16} /></Button>{capabilities.data.elevenLabs.available && !!navigator.mediaDevices && typeof MediaRecorder !== 'undefined' && <Voice onTranscript={transcript => void understand(transcript)} onError={setVoiceError} />}</div><p className="fine">You’ll review and confirm Accord’s interpretation before it is applied.</p></> : <p className="fine">AI understanding is currently unavailable. All structured requirements above still work.</p>}</section></>)}<ErrorNotice error={action.error} /><ErrorNotice error={voiceError} /><PrivateNote /></div>;
}
function localDateInput(value: string) { const d = new Date(value); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16); }

export function Summary() {
  const { roomId = '' } = useParams();
  const base = `/rooms/${segment(roomId)}`;
  const resource = useResource<CapsuleDTO>(`${base}/me/constraints`);
  const capabilities = useResource<Capabilities>('/capabilities');
  return <div className="page narrow private-page"><Link className="back-link" to={base}><ArrowLeft size={15} />Your group</Link><PageHeading eyebrow="Your private capsule" title={resource.data ? `A plan that respects you, ${resource.data.displayName}.` : 'Your boundaries belong here.'} description="This is what Accord will use to check shared options for you." />{resource.loading && <Loading />}<ErrorNotice error={resource.error} retry={resource.refresh} />{resource.data && <>{resource.data.constraints ? <section className="panel"><Tag><Check size={14} />Confirmed by you</Tag><h2>Your confirmed boundaries</h2><BoundaryList constraints={resource.data.constraints} /><h3>Your preferences</h3><p>{resource.data.constraints.softPreference || 'No preferences added.'}</p>{resource.data.confirmedAt && <p className="fine">Confirmed {dateTime(resource.data.confirmedAt)}</p>}<Link to={`${base}/me/intake`} className="text-button">Review or edit <ArrowRight size={15} /></Link></section> : <section className="panel"><h2>Let’s make space for your needs.</h2><p>You haven’t confirmed your requirements yet.</p><LinkButton to={`${base}/me/intake`}>Set my boundaries</LinkButton></section>}{capabilities.data?.backboard.available && <MemoryPanel base={base} onApplied={resource.refresh} />}<section className="privacy-card"><LockKeyhole size={23} /><div><h3>Your privacy, in plain language</h3><p>Your group sees whether an offer works for everyone, not your budget ceiling, personal needs, or reasons. Your group can see the equal share.</p><p>Accord’s backend processes your requirements. When you choose AI input, the model provider processes that input too.</p></div></section><LinkButton to={base}>Back to the group</LinkButton></>}</div>;
}
function MemoryPanel({ base, onApplied }: { base: string; onApplied: () => void }) {
  const memory = useResource<{ source: 'BACKBOARD'; memories: MemoryDTO[] }>(`${base}/me/memories`);
  const action = useAction();
  return <section className="panel memory-panel"><div className="section-heading"><h3>Your Accord memory</h3><Sparkles size={20} /></div><p className="subtle">Remembered from previous planning. Only apply what feels right for this trip.</p>{memory.loading && <Loading />}<ErrorNotice error={memory.error} retry={memory.refresh} />{memory.data?.source === 'BACKBOARD' && (memory.data.memories.length ? <ul className="memory-list">{memory.data.memories.map(item => <li key={item.id}><div><strong>{item.label}</strong><small>{item.applied ? 'Applied to this trip' : 'Available to apply'}</small></div>{item.applied ? <Check size={19} /> : <Button className="secondary small" disabled={action.busy} onClick={() => action.run(async () => { await post(`${base}/me/memories/${segment(item.id)}/apply`, { confirmed: true }); memory.refresh(); onApplied(); })}>Apply to this trip</Button>}</li>)}</ul> : <p className="fine">No remembered preferences yet. You can enter preferences in your private requirements.</p>)}<ErrorNotice error={action.error} /></section>;
}
