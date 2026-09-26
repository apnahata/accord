import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, ArrowRight, Check, LockKeyhole, Mic, Sparkles, Square } from 'lucide-react';
import { Button, ErrorNotice, LinkButton, Loading, PageHeading, PrivateNote, Tag } from './components';
import { api, dateTime, money, post, segment } from './api';
import { useAction, useResource, useRoomEvents } from './hooks';
import { Inbox } from './autopilot';
import { TripAnswerList } from './planning';
import type { Capabilities, CapsuleDTO, Constraints, MemoryDTO } from './contracts';

export function BoundaryList({ constraints }: { constraints: Constraints }) {
  return <dl className="boundary-list"><div><dt>Maximum personal contribution</dt><dd>{money(constraints.maxContributionCents)}</dd></div>{constraints.latestCheckOutAt && <div><dt>Must check out by</dt><dd>{dateTime(constraints.latestCheckOutAt)}</dd></div>}<div><dt>Full cash refund</dt><dd>{constraints.requiresFullCashRefund ? 'Required' : 'Not set as a requirement'}</dd></div><div><dt>Verified step-free access</dt><dd>{constraints.requiresStepFreeAccess ? 'Required' : 'Not set as a requirement'}</dd></div></dl>;
}

export function Voice({ onTranscript, onError }: { onTranscript: (text: string) => void; onError: (error: Error) => void }) {
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

export function Summary() {
  const { roomId = '' } = useParams();
  const base = `/rooms/${segment(roomId)}`;
  const live = useRoomEvents(roomId);
  const resource = useResource<CapsuleDTO>(`${base}/me/constraints`, live.revision);
  const capabilities = useResource<Capabilities>('/capabilities');
  return <div className="page narrow private-page"><Link className="back-link" to={base}><ArrowLeft size={15} />Your group</Link><PageHeading eyebrow="Your private capsule" title={resource.data ? `A plan that respects you, ${resource.data.displayName}.` : 'Your boundaries belong here.'} description="This is what Accord will use to check shared options for you." />{resource.loading && <Loading />}<ErrorNotice error={resource.error} retry={resource.refresh} />{resource.data && <><Inbox roomId={roomId} revision={live.revision} />{resource.data.constraints ? <section className="panel"><Tag><Check size={14} />Confirmed by you</Tag><h2>Your confirmed boundaries</h2><BoundaryList constraints={resource.data.constraints} /><TripAnswerList constraints={resource.data.constraints} /><h3>Your preferences</h3><p>{resource.data.constraints.softPreference || 'No preferences added.'}</p>{resource.data.confirmedAt && <p className="fine">Confirmed {dateTime(resource.data.confirmedAt)}</p>}<Link to={`${base}/me/intake`} className="text-button">Review or edit <ArrowRight size={15} /></Link></section> : <section className="panel"><h2>Let’s make space for your needs.</h2><p>You haven’t confirmed your requirements yet.</p><LinkButton to={`${base}/me/intake`}>Set my boundaries</LinkButton></section>}{capabilities.data?.backboard.available && <MemoryPanel base={base} onApplied={resource.refresh} />}<section className="privacy-card"><LockKeyhole size={23} /><div><h3>Your privacy, in plain language</h3><p>Your group sees whether an offer works for everyone, not your budget ceiling, personal needs, or reasons. Your group can see the equal share.</p><p>Accord’s backend processes your requirements. When you choose AI input, the model provider processes that input too.</p></div></section><LinkButton to={base}>Back to the group</LinkButton></>}</div>;
}
function MemoryPanel({ base, onApplied }: { base: string; onApplied: () => void }) {
  const memory = useResource<{ source: 'BACKBOARD'; memories: MemoryDTO[] }>(`${base}/me/memories`);
  const action = useAction();
  return <section className="panel memory-panel"><div className="section-heading"><h3>Your Accord memory</h3><Sparkles size={20} /></div><p className="subtle">Remembered from previous planning. Only apply what feels right for this trip.</p>{memory.loading && <Loading />}<ErrorNotice error={memory.error} retry={memory.refresh} />{memory.data?.source === 'BACKBOARD' && (memory.data.memories.length ? <ul className="memory-list">{memory.data.memories.map(item => <li key={item.id}><div><strong>{item.label}</strong><small>{item.applied ? 'Applied to this trip' : 'Available to apply'}</small></div>{item.applied ? <Check size={19} /> : <Button className="secondary small" disabled={action.busy} onClick={() => action.run(async () => { await post(`${base}/me/memories/${segment(item.id)}/apply`, { confirmed: true }); memory.refresh(); onApplied(); })}>Apply to this trip</Button>}</li>)}</ul> : <p className="fine">No remembered preferences yet. You can enter preferences in your private requirements.</p>)}<ErrorNotice error={action.error} /></section>;
}
