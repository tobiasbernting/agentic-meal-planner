# Single container, single process, SQLite

---
Status: Proposed (adopted by assumption; not yet explicitly confirmed by owner)
---

The whole system — web UI, HTTP API, planner, cron scheduler — runs as one Node process in one Docker image, persisting to a SQLite file on a mounted volume. There is no external database, broker, or worker tier.

This is a deliberate deviation from the default "app + Postgres" shape. The system is single-household, single-tenant, and write-rare (one planning run per week plus occasional UI edits); an embedded database removes the entire operations surface, which matters for an open-source project whose users just want `docker run`. The cost — no horizontal scaling, no concurrent writers — is irrelevant at this scale. If multi-household SaaS ever appears on the horizon, revisit.
