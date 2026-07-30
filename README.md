# The Noumenon Library

An endless, shared library of pages that do not exist until someone walks into
them. Addresses are Borges-style coordinates —
`/{gallery}/{wall}/{shelf}/{volume}/{page}` (e.g. `/io-9/3/2/17/308`). The
first visitor to an address triggers a language model to crystallize a page
there; it is then stored forever, identical for every visitor after. There is
no search — you can only wander: jump to a random address, step to the next
one, or type a coordinate.

Every page is **machine-generated fiction**. Nothing here is a statement of
fact, and any resemblance to real texts, events, or people is coincidental.
See [`/about`](https://the-noumenon-library.vercel.app/about) for the full
notice, privacy posture, and how to report content.

This is a non-commercial art project — no ads, no accounts, nothing for sale —
released under the **GNU Affero General Public License v3**. This repository
is that license's source requirement.

## Concept and architecture

The `docs/` directory is a project vault covering the concept, architecture,
generation pipeline, economics/safety controls, and legal posture in depth.
It's gitignored (its own repo) rather than published here; if you're reading
this without it, ask the maintainer for access, or treat the code itself —
particularly the comments in `lib/` — as the primary reference.

## Running locally

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). The bare root redirects
to a random address (`app/[[...address]]/page.tsx`); without a `DATABASE_URL`
or provider key, only cached pages resolve.

## Environment variables

Copy `.env.example` to `.env.local` and fill in what you need — at minimum
`DATABASE_URL` and one of `OPENROUTER_API_KEY` / `GOOGLE_API_KEY` (the model
pool's two providers, `lib/providers.ts`) to generate anything new. Every
variable is server-only (read in `lib/config.ts`); none are `NEXT_PUBLIC_*`.

## Database

The schema (`lib/schema.sql`) is a single idempotent file, applied with:

```bash
npm run db:migrate
```

`npm run invite` issues a private-access link (`scripts/invite.mjs`) when
`ACCESS_SIGNING_SECRET` is configured — see `.env.example` for the gate's two
env vars. `npm run takedown` blanks a reported address; `npm run backup` /
`npm run restore:verify` handle off-provider Postgres backups to R2.

## Tests

```bash
npm test
```

Most suites need a local Postgres at `TEST_DATABASE_URL`
(`postgres://localhost:5432/noumenon_test` by default) — they apply
`lib/schema.sql` and run against it directly.
