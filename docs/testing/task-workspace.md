# Task bundles and readable ledger

The task store, session access checks, read-only ledger and installed commit hook
use `.dsh/tasks/<id>/task.json`. The task id is a portable directory name, not a
lossy sanitized filename. Summary documents, active requirement materials and
Sonar reports default to the same bundle. This change does not scan or migrate
another storage layout, and does not modify existing business projects.

`task-paths.ts` defines portable path identities. Only the ledger and the existing
engine configuration receive metadata treatment: arbitrary files, reports and
materials under a task directory never receive a blanket scope exemption.
Active confirmed requirement materials retain their separate fingerprint gate.
Directory traversal, Windows device aliases and linked task directories are
rejected. A source-root-relative namespace keeps child workspaces' documents in
their own physical bundle; linked directories do not widen that namespace.

The workbench provides a task rail, five detail tabs, continuous document reading
and Markdown download. The JSON ledger is still the only mutable task state.
Workflow artifacts use readable labels; execution plans expose file ownership,
dependencies and acceptance conditions. Verification inputs are listed separately
from declared implementation scope. Neither list claims to be an actual Git diff.
Stage navigation marks only the current stage, including during rework. Original
dispatch, independent review, test, source-evidence and Sonar details remain
available. Archived evidence is labeled as a historical delivery record.

Task loading remains paginated at 100 direct task directories. Corrupt or
unreadable records are isolated, access errors remain visible, and changing
workspaces suppresses the previous workspace's results. Both initial reads and
pagination have timeouts and reject obsolete responses. Filters apply to loaded
tasks; the UI discloses when additional pages remain.

Reproduce with `npm run typecheck`, `npm run build`, and `npm test`.
`.task-workspace-test.mjs` checks real filesystem storage, path identities,
linked-directory rejection, metadata scope, strict shipped browser transport and
readable exports. `.requirements-test.mjs` additionally exercises child-workspace
summaries and templates using the production tool. Existing real hook and
pagination regressions run against the new layout. `npm run verify:package`
repeats the applicable behavior from a cold-installed tarball.

Browser inspection uses the production task component and Controller with the
strict shipped codecs against isolated fixture projects. It checks task/detail
selection, filters, keyboard tabs, continuous reading, actual Markdown download,
workspace changes, read errors and narrow screens. UI primitives are adapted in
that isolated preview; this is not a desktop-host or real-model business test.
The keyless rc.3 host probe separately verifies the real preset, task lookup and
requirement-controlled native writes with zero model API calls.

For offline host verification, `TASK_ENGINE_PRESET_NODE_MODULES` may point to an
existing public dependency tree containing the pinned rc.3 host, SDK, preset
registry and subagent package. The verifier checks their versions, references
that dependency tree without modifying it, and extracts the newly packed plugin
into a fresh temporary installation. It does not reuse an existing DSH_HOME or
workspace. Without this option it installs the pinned public packages as before.

Validated on 2026-11-02: type checks and build passed; 415 regressions produced
408 passes, zero failures and seven historical-host skips, plus 143 P0 assertions.
Cold-install package checks passed. The real rc.3 probe reported `model_calls=0`,
`requirement_materials=true`, `bound_template_rendered=true` and
`material_change_revokes_writes=true`. Browser checks covered actual Markdown
download, corrupt-record isolation, access errors, archived analysis tasks,
out-of-order workspace responses, keyboard tabs and 320/360px layouts.
