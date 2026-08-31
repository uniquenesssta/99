# Supplemental AI Execution Rules

These project-governance rules supplement `All ai code.md`. Follow the user's current requirements for task-specific decisions. If these rules conflict with `All ai code.md`, `All ai code.md` takes precedence.

These rules apply only to compatibility and deliverables, module boundaries, and README change records. Do not use them to expand the scope of a task.

## 1. Compatibility and Deliverables

**Prefer the smallest complete deliverable.**

- Preserve existing behavior, interfaces, historical data, configuration, build workflows, and runtime compatibility.
- If a package containing only the changed files fully resolves the issue, deliver only that patch.
- Deliver a full package only when a patch cannot be installed, imported, or run independently, or cannot preserve project integrity. State the reason briefly.
- When dependencies, the runtime environment, or the build process changes, describe only the actual changes and the actions the user must take. Do not add an environment report when nothing changed.
- If a breaking change is unavoidable, state the reason, affected scope, and required migration steps before implementing it.

## 2. Files, Modules, and Naming

**Organize code by responsibility, not by file count.**

- Modify an existing module when the work belongs to its current responsibility. Create a new file or module when the work introduces a distinct responsibility.
- Do not keep adding unrelated or independently evolving logic to one file merely to minimize the number of files.
- Use responsibility boundaries—not line counts—to decide when to create a file. Do not split simple, one-off logic merely for the appearance of modularity.
- Do not create overlapping modules, substitute files, duplicate configuration, or multiple versions of the same file.
- Use version control or the project's designated mechanism for history and backups. Do not preserve old versions by copying files.
- Do not rename existing files or directories without a concrete need. When renaming is necessary, update every reference and verify paths, imports, and builds.
- Do not append version numbers, dates, change descriptions, or suffixes such as `V1`, `V2`, `Final`, `New`, or `Copy` to filenames.
- Give every new file one clear responsibility, a concise name, and a location consistent with the existing project structure.

## 3. README Change Record

**Maintain one canonical record of project changes.**

- Record every version update, enhancement, and bug fix in the root `README.md`.
- Continue using the README's existing change-record section. If none exists, add one consistent `Change Log` section.
- Keep entries concise and outcome-focused. Do not record the AI's workflow, reasoning, or step-by-step activity.
- Do not create a separate CHANGELOG, fix log, release-notes file, or README variant. This rule does not require deleting formal documents that already exist.
- Create or update other documentation only when required by the user's current request or the project's actual needs. Other documents do not replace the README change record.

All other concerns—including task analysis, implementation complexity, edit scope, and verification—are governed by `All ai code.md` and are not restated here.
