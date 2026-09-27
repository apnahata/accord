# Accord deployment infrastructure

This is a deployment template, not a deployed app. Credentials and external services remain placeholders at the user's request. This checkout includes the frontend, local API, authoritative `@accord/domain` package, provider adapters and a Dockerfile. Operational state currently lives in process memory, so the image is only suitable for local evaluation. `/api/health` reports `mongo: UNCONFIGURED`, and the deployment readiness gate correctly fails.

## Required persistence handoff

The included Dockerfile builds the integrated application. Before hosting it as a reliable shared service, replace process-memory room, member, session, proposal, approval, authorization and booking state with Mongo-backed repositories and transactions. The existing `MongoMerchantStore` only persists merchant inventory and its outbox; it is not the coordinator repository. Publish a tested image digest (prefer `registry/image@sha256:...`) once the operational repository is wired. The app listens on `0.0.0.0:3000` and exposes authenticated routes and `/api/health`.

The health endpoint must report `app` and `mongo` as `UP` only after genuine readiness checks. Optional integration labels can be `DOWN` or `UNCONFIGURED`; an unset key is not proof of service health. The container healthcheck fails if either core status is missing/down. Container readiness is **not execution permission**: authorization, stale detection, final preflight and booking gates remain in domain code.

The existing `RoomStreams` implementation uses a single process. Run exactly one coordinator process/replica and keep sticky restart/resync expectations explicit. Durable Mongo merchant transactions are needed for restart safety. Do not horizontally scale until a shared event broker is implemented. Neither this template nor a process-local merchant demonstrates durable deployment behavior.

## Vultr host setup (pending)

1. Supply the real Vultr instance ID/IP, SSH access and approved hostname. No VM or domain was created by this work.
2. Install Docker Engine and its Compose plugin on the host. Configure the Vultr firewall to expose only SSH to the maintainer's IP and TCP 80/443 publicly. API port 3000 stays on the container network; Mongo/Tiger stay external and private/authenticated.
3. Point the hostname's A/AAAA records at that host. Do not advertise a `.tech` domain unless one is actually registered and serving the app.
4. After the persistence handoff, copy this directory to the host. Copy `.env.example` to `.env`, set `ACCORD_IMAGE` and `ACCORD_DOMAIN`, and add the actual Mongo/session/encryption variables. Set file permissions to owner-read/write. Never commit `.env` or use a default/demo admin password.
5. Validate and start on the host:

   ```sh
   docker compose --env-file .env config --quiet
   docker compose --env-file .env pull
   docker compose --env-file .env up -d --wait
   docker compose --env-file .env ps
   ```

6. Verify HTTPS, genuine core health, four distinct member sessions, a merchant mutation, stale consent, private member reasons, the automatic replan (Accord proposes v2 without a manual solve unless `ACCORD_AUTOPILOT=off`), fresh authorization and one demo receipt. Use the HTTP helper below in addition to a real four-browser rehearsal.

Caddy obtains TLS for the configured domain and flushes streaming responses immediately. Keep its persistent `/data` volume for certificate state. No credentials are embedded in the proxy config. The app container receives the secret environment; the proxy receives only the hostname.

On failure, inspect service health and server-side logs with care; do not publish logs containing capsules, sessions or connection strings. Roll back to the preceding tested image digest. Never restore consent from stale application state after a restart. Docker healthchecks mark a container unhealthy; Compose does not automatically restart an otherwise running unhealthy container.

## Deployment verification

The helper uses built-in Node APIs and has no npm dependencies. It opens four authenticated **HTTP SSE clients**, checks anonymous access rejection, optionally sends one explicit admin mutation, and waits for the configured event in all four streams. It requires healthy application/Mongo status. Provider outages remain visible and do not fabricate sponsor success.

Copy `tools/infra/verification.example.json` outside the repository and replace all placeholder paths with the current API routes and request fields. Use four independent member session cookies and the host's session cookie for merchant mutation. Set `expected.where` to the current public proposal ID (and event correlation ID if available), using actual event field paths. All conditions must match; an old proposal's stale event must not satisfy the check. The mutation body must satisfy `@accord/domain` validation. Keep this config owner-readable only.

```sh
node tools/infra/verify-deployment.mjs \
  --config /private/path/accord-verification.json \
  --output /private/path/accord-proof-unique.json \
  --trigger
```

`--trigger` authorizes the configured POST. Without a `trigger` entry, the helper waits for an externally performed action. If a trigger is configured but the flag is omitted, no POST is sent. The output file must not already exist. Exit codes: 0 verified, 1 observed failure, 2 invalid configuration/output.

Reports retain timestamps, origin, allowlisted service status labels, session labels and hashes of observed event IDs. They exclude cookies, tokens, arbitrary health fields and event payloads. An HTTP pass proves only the stated checks; it does not prove four browser UIs, private-channel isolation, backend consent invalidation, payment, sponsor eligibility or Vultr hosting. Confirm those separately. A matched event can be unrelated to the trigger; use a clean room/current proposal and inspect backend event correlation during the rehearsal.

## Local validation

```sh
node --test tools/infra/test/*.test.mjs
ACCORD_IMAGE=accord-validation-only:local ACCORD_DOMAIN=accord.invalid ACCORD_ENV_FILE=.env.example \
  docker compose --env-file deploy/.env.example -f deploy/compose.yaml config --quiet
```

The test server is an explicitly synthetic local fixture. Tests exercise real TCP/SSE delivery and failure cases, but they are not sponsor evidence. They need permission to bind temporary localhost ports. Compose validation parses the template only; it does not start containers, contact Vultr or verify an application image.

Deployment configuration follows [Docker Compose service configuration](https://docs.docker.com/reference/compose-file/services/) and [Caddy reverse proxy streaming configuration](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy). Consult the installed runtime's documentation before provisioning.
