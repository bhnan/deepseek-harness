# Agent Note: Teacher dashboard subtree under teacher-dashboard/

Status: implemented

## Problem

The operator's classroom dashboard stack — two standalone apps (teacher
calendar on :8787, student portfolio on :8797), a `tc` agent CLI, and two DSH
plugin packages (`@bhn/teacher-tools`, `@bhn/apps-proxy`) — ran on the server
with most recent work outside version control history. Agent-assisted
development needs auditable state, and the runtime depends on a patched
harness baseline (`bhn/0.1.1-rc.2-patched`), so the dashboard and the harness
it runs on need to travel together.

## Decision

Everything is collected under `teacher-dashboard/` on the dedicated branch
`bhn/teacher-dashboard`, based on `bhn/0.1.1-rc.2-patched` (the deployed
runtime baseline), keeping the diff against the harness trunk to one new
subtree.

- `teacher-dashboard/teacher-calendar/` — both apps, the `tc` CLI, bridge build
  scripts, requirements/spec docs (six-phase artifacts), and the full test set,
  including carried WIP (markers/makeup-sync, periods tests) preserved as-is.
- `teacher-dashboard/dsh-plugins/` — `teacher-tools` and `apps-proxy` sources.
- `teacher-dashboard/.gitignore` — re-includes `lib/` directories because the
  harness root `.gitignore` ignores `lib/` globally, which would silently drop
  the plugin and CLI source directories on any future `git add`.

Student data never enters the repository: `data/` trees, the portfolio SQLite
database, and `portfolio/scripts/backup/` exam snapshots are excluded
(`.gitignore` plus a manual scan before commit). Plugin `node_modules/` and the
embedded `.git` of copied plugin packages are stripped; `apps-proxy` and
`teacher-calendar` are tracked as plain files, not submodule pointers.

## Alternatives considered

- Pushing the app as its own GitHub repository — rejected: the operator asked
  for a branch of `bhnan/deepseek-harness` so the patched runtime baseline and
  the dashboard development travel together.
- Committing at the harness repo root — rejected: mixes app source into the
  harness trunk and makes the trunk diff unreadable.
- Tracking built bridge bundles (`dist-bridge/`) — rejected: reproducible from
  `scripts/build-bridge.mjs` / `scripts/build-portfolio-bridge.mjs`; source
  only.
- Including the local smoke-evidence logs — rejected: they contain class
  rosters and server paths; they stay in the operator's local `stage/evidence/`.

## Testing

The CLI offline suite passes 24/24 and the app-focused vitest file 12/12
against content byte-identical to what this branch tracks (verified by `diff`
before install). Real-service smoke evidence, the blind-test report, and two
independent code reviews are recorded in the operator's local evidence
directory. `git diff --cached --check` gates trailing whitespace on the commit.

## Consequences

The cost: the harness-wide `lib/` ignore rule required an explicit subtree
exemption file, and the app's carried WIP tests are tracked without having run
in this repository's CI. The benefit: one branch now captures the deployed
runtime baseline plus the dashboard development, and future pushes carry only
the new subtree commits.
