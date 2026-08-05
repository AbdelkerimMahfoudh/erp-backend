# CLAUDE.md — ERP backend

> **The project rulebook is `../CLAUDE.md`** in the documentation repository
> (`erp-docs`). It defines the product identity, core principles, and the
> development, UX and technical rules that govern every change here. This file
> adds only the cross-account coordination protocol below.

<!-- SHARED_HANDOFF_PROTOCOL_START -->

## Mandatory shared handoff protocol

Two Claude Code accounts (`CLAUDE-A` and `CLAUDE-B`) work **sequentially** on
this project. Only one may mutate the workspace at a time.

### Where the coordination files live

The documentation repository (`erp-docs`) is the **parent directory** of this
repository. This repository lives inside the documentation repository's working
tree but is a separate Git repository, excluded by its `.gitignore`.

```bash
cat ../CURRENT_HANDOFF.md
cat ../docs/21_PRODUCT_DECISIONS.md
```

- `CURRENT_HANDOFF.md` — the current snapshot. Replace stale state; do not append.
- `SESSION_LOG.md` — append-only history. Never rewrite an earlier entry.
- `docs/21_PRODUCT_DECISIONS.md` — approved product decisions.
- `docs/22_BACKUP_AND_ROLLBACK.md` — mandatory before any schema migration.

If the directory layout ever differs, find the documentation repository by its
remote rather than by guessing a path:

```bash
git -C <candidate> remote get-url origin   # → .../erp-docs.git
```

### Before modifying code, schema, data, configuration or documentation

1. Locate and read the documentation repository's `CURRENT_HANDOFF.md`.
2. Read the relevant sections of `21_PRODUCT_DECISIONS.md`.
3. Inspect Git status and recent commits in all affected repositories.
4. Compare the handoff's recorded commit IDs with actual local **and** remote state.
5. Check Prisma migration status before database-related work.
6. Resolve discrepancies before implementation.

**The latest explicit user instruction and the approved product decisions
control intended behaviour. Git, database state and test results control
factual implementation state.** If the handoff disagrees with the repository or
the database, stop, investigate, and correct the handoff rather than guessing.

### Session ownership

If `CURRENT_HANDOFF.md` says `IN_PROGRESS` under the other account, **do not
mutate anything** unless the user explicitly states that account reached its
limit or authorises takeover. On an authorised takeover, record the previous
account, the takeover time, and whether its last handoff was complete or
interrupted — then inspect every dirty file before continuing.

Never run both accounts concurrently against the same working tree or database.

### At the start of an authorised implementation session

Update `CURRENT_HANDOFF.md` **before** changing anything:

- `Status: IN_PROGRESS`
- the active account label
- the authorised task
- repository state
- the next intended action

Refresh it at every meaningful checkpoint — especially after a migration, a
commit or a completed subphase. Do not wait until context is nearly exhausted.

### Before yielding to the other account

1. Stop at the safest coherent point possible.
2. Run all relevant verification that time allows.
3. Commit and push only coherent changes.
4. Never hide failing or uncommitted work.
5. Update `CURRENT_HANDOFF.md`.
6. Append a session entry to `SESSION_LOG.md`.
7. Set `READY_FOR_HANDOFF`, or `BLOCKED` with the exact blocker.
8. Record the next exact action, precisely enough that the other account does
   not have to guess.

If work is incomplete when the limit approaches, **leave it uncommitted rather
than making a misleading "finished" commit** — and record every changed file
and the current failure.

### Git rules

- Focused commits. Backend, mobile and documentation are **separate
  repositories** and are committed independently.
- Record cross-repository commit IDs in `CURRENT_HANDOFF.md`.
- Update the documentation repository **last**, so its handoff records the
  final backend and mobile commit IDs.
- Push green checkpoints before switching accounts.
- Never force-push, rewrite shared history, or amend a commit the other account
  has already used.
- Never commit environment files, database dumps, dependencies or secrets.

### Database rules

The database is **shared mutable state**. Before any Prisma schema migration:

1. Inspect migration status.
2. Take a fresh verified backup per `22_BACKUP_AND_ROLLBACK.md`.
3. Record the backup identifier in the handoff.
4. Record any temporary database, and drop it after verification.
5. Record the migration in the handoff immediately after applying it.

Never run `prisma migrate reset` on the shared database. Never delete demo
records without explicit authorisation. **A Git rollback does not roll back the
database** — restoring the dump is a separate, deliberate step.

### Never

Destructive Git commands · force-push · rewriting shared history · resetting
the database · deleting the other account's work · storing secrets in the
handoff files.

<!-- SHARED_HANDOFF_PROTOCOL_END -->
