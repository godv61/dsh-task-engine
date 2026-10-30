# Requirement confirmation contract

The implementation workflow requires an explicit delivery intent and complexity.
It collects clarification answers, renders a requirement summary, and asks the
human to approve that exact version before implementation. Tool execution approval
does not count as business approval. The same contract applies to all repositories
and programming languages.

## Reviewed behavior

- All four adaptive grades require a version-bound confirmation. Low complexity
  uses a short summary in its initial stage rather than adding a separate stage.
- Missing parameters cannot select an older workflow. There is no project opt-out.
- Repeated confirmation of an unchanged, valid version reuses the existing receipt.
- A changed or missing document revokes implementation access. Restoring the exact
  approved bytes synchronizes the tool catalog and execution guard again.
- Changed requirement fields invalidate confirmation; cancelled, rejected, missing,
  or late answers cannot approve a different version.
- Records without the current contract are readable but cannot execute. History
  remains read-only, and does not compete with a current task during Git hook
  selection. An explicitly named archived task cannot authorize a commit.
- The ledger and strict browser codecs preserve the summary, version, state,
  feedback, and stale-document status.

## Validation

The local regression run contains 396 tests: 389 passed, zero failed, seven skipped.
The skips concern the absent historical host seeder package. P0 acceptance adds
143 assertions. Type checks and the server, browser, and hook builds pass.

The keyless DSH rc.3 host probe exercises native tool visibility and execution,
human-question transport with a controlled answerer, confirmation reuse, document
invalidation/restoration, and read-only records. It makes zero model API calls.
The contract check covers 40 Remote methods and 79 strict codec factories.
`verify:package` installs the tarball in an isolated directory and tests shipped
entry points, browser registration, core regressions, real Git hooks, and the CLI.

Tests of unrelated gates use an explicit post-confirmation fixture in
`scripts/fixtures/confirmed-requirement.mjs`. Production code does not import that
helper. `.requirements-test.mjs`, the four-grade tool-chain tests, and the host
probe exercise the confirmation lifecycle itself.

## Current scope

Before confirmation, native file-writing tools and project commands remain
restricted. The built-in `prepare_requirement` operation writes the summary.
Custom Skill multi-document outputs, independent output declarations, and
multiple approval roles are deferred; a required Skill load does not automatically
validate every instruction in its body.

These checks verify the implemented contract and packaging. They do not establish
that a real model has found every business ambiguity, nor replace manual UI or
business-system acceptance.
