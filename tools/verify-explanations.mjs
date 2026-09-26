import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { createApi } from '../packages/server/src/server.ts';

if (!process.env.GEMINI_API_KEY || !process.env.GEMINI_MODEL) {
  process.stderr.write('GEMINI_NOT_CONFIGURED: set GEMINI_API_KEY and GEMINI_MODEL in the gitignored root .env.\n');
  process.exit(1);
}

const prompts = [];
const app = createApi({ geminiFetch: async (url, init) => {
  prompts.push(JSON.parse(String(init?.body)).contents[0].parts[0].text);
  return fetch(url, init);
} });
app.server.listen(0, '127.0.0.1');
await once(app.server, 'listening');
const base = `http://127.0.0.1:${app.server.address().port}/api`;

async function call(path, method = 'GET', body, cookie) {
  const response = await fetch(base + path, { method,
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(cookie ? { cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
}

try {
  const created = await call('/rooms', 'POST', { name: 'Explanation verification', goal: 'Shared stay in Miami', displayName: 'Test Alex' });
  if (created.status !== 201) throw new Error('TEST_ROOM_FAILED');
  const room = `/rooms/${created.data.roomId}`;
  const participants = [{ name: 'Test Alex', cookie: created.cookie, maximum: 35001, preference: 'walkable' }];
  for (const [name, maximum, preference] of [
    ['Test Priya', 45002, 'walkable'], ['Test Jordan', 45003, 'near activities'], ['Test Mateo', 45004, 'quiet'],
  ]) {
    const joined = await call(`/invites/${created.data.inviteToken}/join`, 'POST', { displayName: name });
    if (joined.status !== 201) throw new Error('TEST_JOIN_FAILED');
    participants.push({ name, cookie: joined.cookie, maximum, preference });
  }
  for (const member of participants) {
    const result = await call(room + '/me/constraints', 'POST', {
      maxContributionCents: member.maximum, requiresFullCashRefund: member.name === 'Test Jordan',
      requiresStepFreeAccess: false, softPreference: member.preference, confirmed: true,
    }, member.cookie);
    if (result.status !== 200) throw new Error('TEST_CONSTRAINTS_FAILED');
  }
  const offers = await call(room + '/offers', 'GET', undefined, participants[0].cookie);
  const recommended = offers.data.offers.find(offer => offer.offerId === offers.data.recommendedOfferId);
  if (!recommended) throw new Error('NO_FEASIBLE_TEST_OFFER');
  const publicResult = await call(room + '/offers/explanation', 'POST', {
    recommendedOfferId: recommended.offerId, offerVersion: recommended.offerVersion,
  }, participants[1].cookie);
  const solved = await call(room + '/solve', 'POST', {}, participants[0].cookie);
  if (solved.status !== 200) throw new Error('TEST_SOLVE_FAILED');
  const privateResult = await call(`/proposals/${solved.data.proposal.proposalId}/me/explanation`, 'POST', {
    proposalHash: solved.data.proposal.proposalHash,
  }, participants[0].cookie);

  const changedPrice = await call('/merchant/events', 'POST', {
    offerId: recommended.offerId, expectedOfferVersion: recommended.offerVersion,
    mutation: { type: 'INCREASE_PRICE', newTotalCents: 144000 },
  }, participants[0].cookie);
  if (changedPrice.status !== 200) throw new Error('TEST_PRICE_MUTATION_FAILED');
  const changedTerms = await call('/merchant/events', 'POST', {
    offerId: recommended.offerId, expectedOfferVersion: changedPrice.data.offerVersion,
    mutation: { type: 'CHANGE_CANCELLATION', code: 'TRAVEL_CREDIT' },
  }, participants[0].cookie);
  if (changedTerms.status !== 200) throw new Error('TEST_TERMS_MUTATION_FAILED');
  const stalePath = `/proposals/${solved.data.proposal.proposalId}/me/explanation`;
  const staleBody = { proposalHash: solved.data.proposal.proposalHash };
  const alexStale = await call(stalePath, 'POST', staleBody, participants[0].cookie);
  const jordanStale = await call(stalePath, 'POST', staleBody, participants[2].cookie);

  const publicPrompt = prompts[0] ?? '';
  const privatePrompt = prompts[1] ?? '';
  const proof = {
    observedAt: new Date().toISOString(), provider: 'gemini', model: process.env.GEMINI_MODEL,
    scenario: 'Synthetic four-member stay; live public and private explanation calls through the local Accord API',
    publicStatus: publicResult.status, publicSource: publicResult.data.source,
    publicReasonCount: publicResult.data.reasons?.length ?? 0,
    publicTradeoffCount: publicResult.data.tradeoffs?.length ?? 0,
    publicInputExcludesAllPrivateLimits: participants.every(member => !publicPrompt.includes(String(member.maximum))),
    publicInputExcludesMemberNames: participants.every(member => !publicPrompt.includes(member.name)),
    privateStatus: privateResult.status, privateSource: privateResult.data.source,
    privateReasonCount: privateResult.data.reasons?.length ?? 0,
    privateInputContainsOwnLimit: privatePrompt.includes(String(participants[0].maximum)),
    privateInputExcludesOtherLimits: participants.slice(1).every(member => !privatePrompt.includes(String(member.maximum))),
    privateInputExcludesOtherNames: participants.slice(1).every(member => !privatePrompt.includes(member.name)),
    staleAlexStatus: alexStale.status,
    staleAlexSeesOwnBudgetFailure: alexStale.data.reasons?.some(reason => reason.includes('share exceeds your confirmed maximum')) === true,
    staleJordanStatus: jordanStale.status,
    staleJordanSeesOwnRefundFailure: jordanStale.data.reasons?.some(reason => reason.includes('full cash refund you required')) === true,
    staleJordanExcludesAlexLimit: !(prompts[3] ?? '').includes(String(participants[0].maximum)),
    errorCodes: [publicResult.data.code, privateResult.data.code].filter(Boolean),
  };
  const verified = proof.publicStatus === 200 && proof.publicSource === 'GEMINI' && proof.publicReasonCount > 0
    && proof.publicInputExcludesAllPrivateLimits && proof.publicInputExcludesMemberNames
    && proof.privateStatus === 200 && proof.privateSource === 'GEMINI' && proof.privateReasonCount > 0
    && proof.privateInputContainsOwnLimit && proof.privateInputExcludesOtherLimits && proof.privateInputExcludesOtherNames
    && proof.staleAlexStatus === 200 && proof.staleAlexSeesOwnBudgetFailure
    && proof.staleJordanStatus === 200 && proof.staleJordanSeesOwnRefundFailure && proof.staleJordanExcludesAlexLimit;
  process.stdout.write(JSON.stringify({ ...proof, verified }) + '\n');
  if (!verified) process.exitCode = 1;
  else if (process.argv.includes('--record')) {
    await mkdir('sponsor-evidence', { recursive: true });
    await writeFile('sponsor-evidence/gemini-explanations-live.json', JSON.stringify({ ...proof, verified }, null, 2) + '\n');
  }
} finally {
  app.state.streams.close();
  app.server.closeAllConnections();
  await new Promise(resolve => app.server.close(resolve));
}
