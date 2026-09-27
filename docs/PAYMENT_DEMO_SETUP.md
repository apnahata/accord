# CyberSource + Nuitée Connect liteAPI demo setup

This build keeps the existing AI intake, preference analysis, constraint solver, and hotel search intact. The new orchestration begins only after the solver creates an exact hotel proposal.

## What the demo executes

1. Every member approves the proposal hash and their exact share.
2. The final approval starts checkout automatically.
3. Accord records each approved contribution in its append-only ledger, revalidates the current offer, and asks CyberSource for one shared authorization covering the exact group total.
4. Accord re-quotes, prebooks, and books the exact Nuitée Connect liteAPI sandbox rate.
5. Accord captures that one CyberSource sandbox authorization.
6. All browsers receive live events. The shared receipt shows the hotel confirmation and shared transaction; each member's `/me` history shows only their own contribution and allocation in that group transaction.

If price or terms change before booking, the proposal becomes stale and the shared CyberSource hold is reversed. If capture is interrupted after the hotel confirms, **Resume secure checkout** retries only the unfinished capture.

## Required `.env` values

Create a **Shared Secret** key in CyberSource Business Center TEST and fill:

```dotenv
CYBERSOURCE_MERCHANT_ID=
CYBERSOURCE_KEY_ID=
CYBERSOURCE_SECRET_KEY=
CYBERSOURCE_TEST_CARD_NUMBER=
CYBERSOURCE_TEST_CARD_EXPIRY_MONTH=
CYBERSOURCE_TEST_CARD_EXPIRY_YEAR=
CYBERSOURCE_TEST_CARD_SECURITY_CODE=
```

Use only a CyberSource-published sandbox test card, never a real card. The server authenticates with JWT shared secret against `apitest.cybersource.com`. For request message-level encryption, download the sandbox MLE public certificate and set:

```dotenv
CYBERSOURCE_MLE_PUBLIC_CERT_PATH=/absolute/path/to/the/sandbox-certificate.pem
```

Hotel booking uses exactly one credential: `LITEAPI_KEY`. Copy the `sand_...` key from Nuitee Connect → Developer → API Keys → Sandbox. It covers hotel search, live rates, prebook, and sandbox booking. A sandbox booking produces a provider confirmation but does not reserve a real-world hotel.

Verify the key before opening the browser:

```bash
npm run verify:liteapi
```

## Verify the connection

```bash
npm run verify:cybersource
```

This creates a $1.00 sandbox authorization and immediately reverses it. Confirm both IDs in CyberSource Business Center TEST.

To verify another sandbox amount, pass cents explicitly, for example `CYBERSOURCE_VERIFY_AMOUNT_CENTS=500 npm run verify:cybersource` for $5.00. Successful authorizations are immediately reversed.

Then run:

```bash
npm run dev:api
npm run dev:web
```

Create four accounts. You may sign out and switch accounts in one browser, or use separate browser profiles to watch all four update simultaneously. Join from the same invitation, confirm four different preference profiles, and approve the exact proposal in each private view. The fourth approval performs the full workflow.

## Honest demo boundary

CyberSource test transactions are real gateway calls visible in Business Center, but no real money moves. Nuitée Connect liteAPI sandbox booking creates a provider-side test confirmation, but no real accommodation is reserved. This build uses one server-side sandbox card as a shared group funding source and maintains a private contribution allocation for each member; adding four independently tokenized user cards requires CyberSource Flex Microform/TMS onboarding.
