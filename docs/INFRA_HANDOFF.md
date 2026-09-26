# Integrated local app handoff

This branch now contains the frontend, canonical domain package, local API and the existing provider adapters. The package import direction is `frontend/server -> @accord/domain`; provider adapters receive domain contracts from the server. Do not copy constraints, offer, consent or proposal schemas into another package.

The local core flow is implemented and tested with four separate HTTP sessions. Merchant state, sessions, rooms, approvals and booking receipts are stored in process memory. This is appropriate for the local demo only. Restarting the API resets state. The health endpoint reports `mongo: UNCONFIGURED`; the deployment health gate therefore does not certify this app as durable or production-ready.

Next persistence work is to replace the process-memory operational state with authenticated Mongo repositories and transactions for rooms, members, sessions, proposals, approvals, authorizations and bookings. The existing `MongoMerchantStore` covers the merchant transaction/outbox only. Its outbox consumer must commit the domain stale transition before optional Tiger/Solana work. A durable store is also needed for Backboard assistant mappings and pending Solana commitments.

Optional sponsor services remain disabled/unverified without credentials. Do not show simulated authorization as Visa payment or use a Solana explorer URL until a transaction is confirmed. The public activity feed currently reflects local backend events; it is not a Tiger query. No Vultr host or domain is deployed.
