# AI Software Development Guidelines

Behavioral guidelines for designing, implementing, modifying, and verifying maintainable software. Apply them alongside project-specific instructions.


**Core principle:** Choose the most appropriate solution. Simplicity is a tiebreaker between equally sound designs, not the primary goal.


## 1. Understand Before Designing

**Understand the current requirement, the existing system, and the known direction of change before choosing a design.**


- Inspect the relevant code, architecture, data flow, dependencies, conventions, and available verification before making changes.

- Define the requested outcome, material constraints, non-goals, and completion criteria.

- State only assumptions that materially affect architecture, scope, compatibility, data, or verification.

- Consider confirmed near-term plans and authoritative project documentation when they affect a decision. Do not invent a roadmap from possibilities alone.

- If different interpretations would materially change the design or result, explain the tradeoff and ask. Otherwise, state a reasonable assumption and proceed.

- Give greater analysis to decisions that are expensive or risky to reverse. Keep low-risk, easily reversible decisions lightweight.


## 2. Choose an Appropriate Design

**Remove unnecessary complexity, not necessary structure. Design for changeability, not for imagined features.**


- Evaluate solutions by correctness, architectural fit, responsibility boundaries, compatibility, maintainability, testability, reversibility, and the cost of future change.

- Implement only the requested behavior, but include the supporting structure required to implement it correctly and maintainably.

- Keep responsibilities that change for different reasons in separate modules, even when one of them currently has only a single use.

- Do not create abstractions solely for hypothetical reuse. Create one when it represents a real responsibility or system boundary, follows the established architecture, improves testability, or supports a confirmed direction of change.

- Do not implement unrequested features, speculative extension systems, or generalized configurability without a current requirement, confirmed near-term need, or established project convention.

- Preserve clean extension boundaries for known future changes without implementing those future features prematurely.

- Handle credible failure modes, especially at external boundaries such as files, networks, processes, user input, persistence, and third-party services.

- Do not treat fewer lines, fewer files, or fewer modules as proof of a better design.

- When multiple solutions are equally correct, compatible, maintainable, and aligned with the architecture, prefer the simpler one.


### Enforce Responsibility-Based Modularization

**A file or module must represent one cohesive responsibility. Place new functionality according to its actual ownership and reason for change, not merely in a file that already participates in the call chain.**


#### Responsibility boundary criteria

Treat logic as a distinct responsibility when one or more of the following conditions apply. These signals require an explicit placement decision; they do not justify mechanical fragmentation by themselves.


- It changes for a reason different from the current module's primary responsibility.

- It owns an independent business capability, domain concept, workflow stage, state lifecycle, data transformation, external integration, persistence concern, or presentation concern.

- It can be named, described, tested, replaced, or evolved independently.

- It introduces its own validation, error handling, configuration, dependencies, interfaces, state ownership, or lifecycle management.

- It is used by multiple callers or forms a stable boundary between layers, features, or subsystems.

- Keeping it in the current file would introduce unrelated imports, shared mutable state, cross-feature condition branches, or knowledge of implementation details outside that file's declared responsibility.


#### File creation and placement

- Before adding functionality, identify the responsibility that owns it and determine whether an existing module already represents that responsibility clearly.

- Add functionality to an existing file only when it is a cohesive extension of that file's declared responsibility, shares the same reason for change, and does not broaden the file into another architectural concern.

- Create a new file or module when the functionality introduces a distinct responsibility, independently evolving behavior, a reusable or architectural boundary, separate state ownership, or a separately testable unit.

- Do not combine business rules, persistence, transport, UI state, validation, orchestration, and external-service integration in one file unless the established architecture explicitly defines them as one cohesive responsibility.

- Do not use generic files such as `utils`, `helpers`, `common`, `manager`, `service`, or `misc` as containers for unrelated logic. Their contents must still share one explicit responsibility.

- New files must use concise responsibility-based names and be placed in the layer or feature directory that owns the behavior. Do not create parallel, duplicate, substitute, or version-suffixed modules.


#### Code accumulation detection

Review a file for decomposition when one or more of the following signals appear:


- The file contains multiple unrelated feature flows, domain concepts, or lifecycle owners.

- Different sections require substantially different dependencies, data models, error strategies, permissions, or test setups.

- New work repeatedly adds branches based on feature type, operation mode, source type, caller identity, or unrelated state combinations.

- Changes to one feature regularly risk affecting unrelated behavior in the same file.

- Understanding, testing, or reviewing one responsibility requires reading large amounts of unrelated code.

- The file has become a coordination point for multiple subsystems instead of an implementation of one responsibility.

- The file's public surface, imports, mutable state, or dependency directions keep expanding as unrelated features are added.

File size and line count are warning signals, not architectural proof. A large cohesive file may remain valid, while a small file that mixes unrelated responsibilities may already require decomposition.


#### Decomposition requirements

- When modifying a file that already mixes responsibilities, do not continue adding to the accumulation without evaluating decomposition.

- When safe within the actual impact boundary, extract the responsibility affected by the current work together with the directly required supporting logic, rather than attempting an unrelated whole-project rewrite.

- Preserve one authoritative owner for each state, rule, and side effect. Do not duplicate logic or state merely to make a split easier.

- Preserve clear dependency direction and expose explicit interfaces between modules. Avoid circular dependencies, hidden cross-module mutation, duplicated state, and pass-through wrapper layers without architectural value.

- After creating or splitting modules, verify imports, dependency direction, public interfaces, state ownership, tests, builds, and every affected call path.


#### Avoid artificial fragmentation

- Do not create one file per function, split tightly coupled private helpers without a concrete benefit, or introduce layers that only forward calls.

- Keep implementation details together when they serve the same responsibility, share the same lifecycle and state owner, and are safest to change and test as one unit.

- Do not split solely to reduce line count, satisfy an arbitrary file-size target, imitate another project's structure, or create the appearance of modularity.

**The objective is neither fewer files nor more files. The objective is that every module has a clear responsibility, one understandable reason to change, controlled dependencies, explicit state ownership, and an independently verifiable boundary.**


## 3. Repair the Complete Affected Chain

**Determine the change scope from the problem's actual impact boundary. Do not optimize for the smallest local patch; resolve the issue completely across every confirmed affected path.**


- Preserve existing behavior, interfaces, data, configuration, and runtime compatibility unless the task explicitly requires a change.

- Identify the root cause and inspect relevant upstream and downstream flows, shared modules, data paths, interfaces, state synchronization, error handling, persistence, and compatibility paths for related effects.

- Fix every confirmed affected point and credible same-root issue within the real impact boundary. Do not leave known risks unresolved merely to reduce changed lines, files, or modules.

- Modify an existing module when the work belongs to its responsibility. Create or reorganize modules when the correct repair introduces or reveals a distinct responsibility.

- Perform supporting refactors, interface adjustments, data corrections, or structural improvements when they are necessary to complete the repair cleanly, prevent recurrence, or preserve a valid architecture. Keep them within the affected boundary.

- Follow existing conventions unless they materially prevent a correct, safe, or maintainable implementation. Any necessary deviation must remain targeted and internally consistent.

- Do not combine the requested work with unrelated refactors, formatting changes, comment rewrites, speculative features, or general cleanup.

- Leave unrelated pre-existing dead code unchanged unless it materially affects the repair or creates significant risk.

- Remove imports, variables, functions, files, compatibility paths, and temporary workarounds made unnecessary by the current repair.

- For destructive, irreversible, compatibility-breaking, or data-shape changes, define the migration, compatibility, and rollback approach before implementation.

- Every intentional or mechanically generated change must trace to the requested outcome, a confirmed affected path, the supporting structure required by the repair, or its verification.

## 4. Verify the Whole Result

**Define success before implementation. Continue until the result—not merely the code—has been verified.**


- Translate the request into observable acceptance criteria appropriate to the task's scope and risk.

- For new behavior, verify the main path, relevant boundaries, and failure cases. For bug fixes, reproduce the issue when feasible and confirm the original path no longer fails. For refactors, verify behavior before and after the change.

- For repairs, verify the original issue, affected upstream and downstream flows, shared dependencies, cross-module calls, state and data consistency, compatibility paths, and relevant regression paths.

- Check credible same-root scenarios and adjacent paths that could fail for the same underlying reason, without expanding verification into unrelated areas.

- For complex, ambiguous, high-risk, or long-running tasks, state a brief plan with a verification point for each meaningful stage.

- Use the project's existing verification approach. Run the most relevant available tests, type checks, lint checks, builds, integration checks, or targeted smoke tests in proportion to the risk.

- Review the final diff for regressions, unintended scope, architectural inconsistency, incomplete cleanup, accidental generated changes, and unresolved effects on related chains.

- If verification fails, continue correcting the work. If a relevant check cannot be run, state what remains unverified, why, and the next best check.

- Do not claim completion until the original issue, confirmed affected chains, and acceptance criteria have been verified, or any remaining limitation is explicitly disclosed.

## 5. Execute Directly and Report Concisely

**Apply the governing rules directly. Do not repeat them in routine responses; keep communication focused on results, material limitations, and required user actions.**


- Do not quote, restate, summarize, or explain the governing rules merely to demonstrate compliance.

- Explain details only when requirements contain a material conflict, essential information is unavailable, a consequential assumption must be disclosed, or relevant verification cannot be completed.

- Keep progress updates and final responses concise. State only the completed result, affected scope, verification outcome, remaining limitations, and required user actions when applicable.

- Put substantive implementation details, affected modules and chains, compatibility changes, verification coverage, and relevant limitations in the root `README.md` instead of expanding the conversation response.

- Keep README records concise and outcome-focused. Do not record hidden reasoning, internal analysis, rule-compliance narration, or unnecessary step-by-step workflow.


---

**These guidelines are working when:** the current requirement is fully met, the design remains coherent, necessary structure is preserved, known evolution does not require avoidable rework, speculative systems are not built, and the result is verified before completion is claimed.
