---
title: Legal & Safety
---

# Legal & Safety

## Jurisdiction

EU / Poland. DSA (Digital Services Act) and GDPR frameworks apply.

---

## Content moderation

**No aesthetic filtering** — the library stays dark, strange, and uncensored by design. Strangeness and darkness are features.

**One moderation pass** on novel pages before storing. Scope: narrow illegal-content categories only (CSAM, incitement, etc.). Not taste, not tone.

### Mechanism (🟢 implemented, Phase 4)

- A **pool of free secondary LLMs** (provider-agnostic, via OpenRouter) run in parallel, each returning PASS/FAIL; combined by a policy (default `any-fail`). See [Architecture §7](./architecture.md). A hosted moderation endpoint can swap in behind the same `moderate(text)` interface.
- Runs on novel pages only — not on cache hits
- On fail: **regenerate once** (a fresh sample); if the regeneration also fails, the content is discarded (never stored) and the address is released to retry on a later visit. The double-failure emits a `moderation_persistent_reject` monitoring event so a human can review and, if warranted, take the address down — there is no automatic permanent block
- If moderation is **undetermined** (all pool models unavailable), the page is not stored and the address is retried on a later visit — never store unmoderated content
- **Fail-closed in production (Phase 9):** the safety gate can be switched off locally (`MODERATION_ENABLED=false`) as a dev unblock, but in production that switch makes `moderate()` **throw** (emitting a `moderation_disabled_in_production` alert) rather than pass — so a misconfigured deploy degrades to explore-only instead of ever storing unmoderated pages. **Launch note:** enabling the pool for real still depends on a reliable moderation setup (the free pool currently 429s); until then production stays explore-only. Moderation uses a **short, curated** pool (reliability + recall), distinct from generation's long, diverse one — see [Architecture §7](./architecture.md)

### Real-person data

Covered by the moderation pass and reactive takedown. No separate detection system needed at this scale.

---

## Copyright

**Not filterable by construction** — the library generates text; filtering for similarity to copyrighted works is not tractable.

Mitigations:
- Staying non-commercial
- Wandering-only navigation (no reverse text search — you cannot look up whether a passage exists)
- Act on all copyright reports promptly

Legal disclaimer on the site: content is machine-generated fiction; non-commercial project. 🟢 **Implemented (Phase 9):** a global footer disclaimer on every page + an `/about` page (`app/about/page.tsx`) carrying the full machine-generated-fiction notice, non-commercial notice, AGPL v3 + source link, GDPR/DSA posture, and the report path below.

---

## Reactive takedown

Committed: report received → address blanked promptly. The address is set to `status = taken_down` and serves a placeholder; it does not re-generate. (See the `pages.status` field in [Architecture §8](./architecture.md).)

🟢 **Mechanism (Phase 4):** `npm run takedown -- <address>` (`scripts/takedown.mjs`). It upserts, so it works whether or not the page was ever generated (pre-emptive blocks). Deliberately a **script, not an HTTP endpoint** — there is no admin auth yet, and an open "blank this page" route would itself be an abuse vector.

🟢 **Reporter-facing intake (Phase 9):** **email-only**, surfaced on `/about` (contact address via `REPORT_CONTACT_EMAIL`; reporters are asked to include the page address). Chosen over an in-app report form to add no new endpoint or spam surface. The path is: report email → operator reviews → operator runs the takedown script. The takedown itself stays the script above.

No proactive system beyond moderation at generation time.

---

## GDPR

- No user accounts required for wandering
- No personal data collected beyond what's inherent in server logs
- Donation flow: handled by payment processor; not stored locally
- Generation parameters logged per page are not PII

---

## License

**AGPL v3** — anyone running a modified version as a network service must publish their source. Chosen to prevent closed commercial forks of the library.
