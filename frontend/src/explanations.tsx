import { useState } from 'react';
import { Sparkles } from 'lucide-react';
import { Button, ErrorNotice } from './components';
import { post, segment } from './api';
import { useAction, useResource } from './hooks';
import type { Capabilities } from './contracts';

type Explanation = { source: 'GEMINI'; model: string; headline: string; reasons: string[]; tradeoffs?: string[]; nextAction: string };
type PublicExplanation = Explanation & { recommendedOfferId: string; offerVersion: string };
type PrivateExplanation = Explanation & { proposalHash: string };

function Story({ story, privacy }: { story: Explanation; privacy: 'public' | 'private' }) {
  return <div className="explanation-story" aria-live="polite">
    <p className="eyebrow"><Sparkles size={14} /> Gemini · {privacy === 'private' ? 'Only you can see this' : 'Group-safe facts'}</p>
    <h3>{story.headline}</h3>
    <ul>{story.reasons.map(reason => <li key={reason}>{reason}</li>)}</ul>
    {!!story.tradeoffs?.length && <><h4>Tradeoffs</h4><ul>{story.tradeoffs.map(tradeoff => <li key={tradeoff}>{tradeoff}</li>)}</ul></>}
    <p>{story.nextAction}</p>
    <p className="fine">Gemini selected these details from Accord’s verified checks. The backend still decides which stays work and whether consent is valid.</p>
  </div>;
}

export function PublicExplanationCard({ roomId, recommendedOfferId, offerVersion }: { roomId: string; recommendedOfferId: string; offerVersion: string }) {
  const capabilities = useResource<Capabilities>('/capabilities');
  const action = useAction();
  const [story, setStory] = useState<PublicExplanation>();
  if (!capabilities.data?.ai.available) return null;
  return <section className="panel explanation-panel">
    {story ? <Story story={story} privacy="public" /> : <><h3>Want the reasoning in plain English?</h3><p>Gemini can highlight the verified fit and tradeoffs among suitable stays. Personal requirements stay out of this explanation.</p><Button className="secondary" disabled={action.busy} onClick={() => action.run(async () => {
      const result = await post<PublicExplanation>(`/rooms/${segment(roomId)}/offers/explanation`, { recommendedOfferId, offerVersion });
      if (result.source !== 'GEMINI' || result.recommendedOfferId !== recommendedOfferId || result.offerVersion !== offerVersion) throw new Error('The offer changed. Refresh the stays and try again.');
      setStory(result);
    })}>{action.busy ? 'Considering the stays…' : 'Ask Accord to explain'}<Sparkles size={16} /></Button></>}
    <ErrorNotice error={action.error} />
  </section>;
}

export function PrivateExplanationCard({ proposalId, proposalHash }: { proposalId: string; proposalHash: string }) {
  const capabilities = useResource<Capabilities>('/capabilities');
  const action = useAction();
  const [story, setStory] = useState<PrivateExplanation>();
  if (!capabilities.data?.ai.available) return null;
  return <section className="panel explanation-panel private-explanation">
    {story ? <Story story={story} privacy="private" /> : <><h3>What does this mean for you?</h3><p>Gemini can highlight your own verified checks and share. Other members’ requirements are never sent with this request.</p><Button className="secondary" disabled={action.busy} onClick={() => action.run(async () => {
      const result = await post<PrivateExplanation>(`/proposals/${segment(proposalId)}/me/explanation`, { proposalHash });
      if (result.source !== 'GEMINI' || result.proposalHash !== proposalHash) throw new Error('The proposal changed. Refresh and try again.');
      setStory(result);
    })}>{action.busy ? 'Reviewing your checks…' : 'Explain my checks'}<Sparkles size={16} /></Button></>}
    <ErrorNotice error={action.error} />
  </section>;
}
