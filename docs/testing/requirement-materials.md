# Requirement materials before implementation approval

The model can collect product or technical feedback into files without gaining
native file-writing, shell or implementation capabilities. This contract applies
to every repository and complexity grade, at its requirement-owning stage.

`write_requirement_material` accepts either text or an HTML template specification.
Files live only in `.dsh/tasks/<task_id>/materials/`. Supported text formats are HTML,
Markdown, JSON, TXT, CSV and SVG. JSON outputs must parse; limits are 1 MiB per file
and 64 material records per task. Existing unowned files and human modifications
are protected. Changing an owned draft needs its current hash and the host's
atomic file version. Directory links, traversal, Windows device names, executable
extensions and instruction filenames are rejected. Filesystem sandbox policies
still apply, including when a caller requests broader execution permissions.

Templates must be HTML assets of a Skill bound to the current stage and genuinely
loaded in the current task/session. Only the selected `application/json` script
data block is replaced. JSON is serialized with HTML-sensitive characters escaped;
the template's other markup and scripts are preserved and never executed by the
tool. An optional `identity_field` receives a content-specific material id for
form cache isolation. This mechanism has no project, business language or template
element id hardcoded into it.

The host records paths, versions, timestamps, text fingerprints and template
provenance, not repeated HTML bodies in the ledger. Active material versions are
part of the requirement summary source. A new or revised material invalidates a
pending confirmation, including a delayed human answer. Editing or deleting an
approved material revokes native implementation access and blocks commits.
Restoring exact approved content can reuse the existing confirmation.

`retire_requirement_material` requires the registered name and current hash.
It preserves the file and historical metadata while removing that material from
the current approval basis. Approved requirements must first be revised. This
provides recovery when an obsolete or missing material should be replaced rather
than overwritten. Registered active materials may be committed as requirement
artifacts without becoming business-code verification inputs; retired or
unregistered files receive no automatic scope exemption.

Generating a form, returning filled answers, or setting a page's completion flag
does not approve implementation. The model must inspect feedback, update the
requirement artifact, prepare the final summary and ask for approval of that
exact version. Multi-role signoff and semantic validation of arbitrary custom
Skill deliverables are separate capabilities.

Regression coverage lives in `.requirements-test.mjs`, the real commit hook test,
strict browser codec roundtrips and the keyless rc.3 preset probe. The probe uses
an offline adapter that throws on any model invocation; it must report zero calls.

Local validation: type checks and builds passed; 415 regression tests produced
408 passes, zero failures and seven historical-host skips, plus 143 P0 assertions.
The keyless rc.3 host exercised text material output, a bound Skill template,
rejected traversal, unchanged native write restrictions before confirmation, and
permission revocation/restoration after material changes. Its direct registry
driver journals the real loader call and result through the public session API,
since registry execution itself omits the agent-loop journal. No successful load
or human business decision is inferred from a model claim.

These tests do not establish real-model question quality or a manually verified
browser interaction. The supplied HTML baseline is preserved; its generator and
answer checks are validated separately as an optional Skill package.
