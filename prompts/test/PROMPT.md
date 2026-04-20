0a. study @TEST-SPEC.md to learn about what we are building

0b. study @SPEC.md for context about the project

0b. study the existing source code in this repo

0c. study @fix_plan.md

1. Your task is to fully implement the test harness as specified in the test spec. Follow the @fix_plan.md and choose the most single (1) most important thing. Before making changes search codebase (don't assume not implemented) using subagents. You may use up to 500 parallel subagents for all operations but only 1 subagent for build/tests.

2. When you discover an issue in the test harness implementation. Immediately update @fix_plan.md with your findings using a subagent. When the issue is resolved, update @fix_plan.md and remove the item using a subagent.

3. When you successfully implement a task in @fix_plan.md, then add changed code and @fix_plan.md with "git add -A" via bash then do a "git commit" with a message that describes the changes you made to the code. After the commit do a "git push" to push the changes to the remote repository.

4. If there are no more tasks @fix_plan.md, then follow the instructions in @PLANNING-PROMPT.md to find more tasks. Once you have updated the task with with new tasks, commit, push and do not implement yet. Instead consider your job done. If there are no more tasks left to find even after following these instructions, then write in README.md that the tests are ready to test production implementations.

5. The goal is to implement the test harness fully prior to working on the implementation. Therefore we expect certain tests to fail when we run them. You are done when (1) all test are correctly implemented (2) all tests that are supposed to pass (given that there is not an implementation) pass (2) all tests that are supposed to fail (given that there is not an implementation) fail.

9999. Important: We want single sources of truth, no migrations/adapters.

999999. As soon as there are no build or unexpected test errors:
   - Create a checkpoint tag in a non-release namespace: `git tag checkpoint/$(date -u +%Y%m%d-%H%M%S)` and push it. This is for rollback only. DO NOT create plain semver tags (`0.0.1`, `v0.1.44`, etc.) — those are reserved for the Changesets release flow and pushing one will NOT trigger a publish in this repo anymore.
   - If the iteration changed user-facing behavior of `loop-extender` (anything a consumer would notice in npm: bug fix, new feature, breaking change), also run `npx changeset` to record a brief description and pick the bump level (`patch` / `minor` / `major`). Skip changesets for purely internal work (refactors, test-only changes, doc tweaks, CI config). Commit the generated `.changeset/*.md` file with the rest of your changes — it will be aggregated into the next "Version Packages" PR on merge to main, which the human merges to actually publish to npm.

999999999. You may add extra logging if required to be able to debug the issues.

9999999999. ALWAYS KEEP @fix_plan.md up to do date with your learnings using a subagent. Especially after wrapping up/finishing your turn.

99999999999. When you learn something new about how to run code in this codebase make sure you update @AGENT.md using a subagent but keep it brief. For example if you run commands multiple times before learning the correct command then that file should be updated.

99999999999999. IMPORTANT when you discover a bug resolve it using subagents even if it is unrelated to the current piece of work after documenting it in @fix_plan.md

9999999999999999999. Keep AGENT.md up to date with information on how to build code in this codebase and your learnings to optimise the build/test loop using a subagent.

999999999999999999999. For any bugs you notice, it's important to resolve them or document them in @fix_plan.md to be resolved using a subagent.

99999999999999999999999999. When @fix_plan.md becomes large periodically clean out the items that are completed from the file using a subagent.

99999999999999999999999999. If you find inconsistencies in the specs then add them to SPEC-PROBLEMS.md.

9999999999999999999999999999. DO NOT IMPLEMENT PLACEHOLDER OR SIMPLE IMPLEMENTATIONS. DO NOT SKIP TESTS. WE WANT FULL IMPLEMENTATIONS. DO IT OR I WILL YELL AT YOU

9999999999999999999999999999999. SUPER IMPORTANT DO NOT IGNORE. DO NOT PLACE STATUS REPORT UPDATES INTO @AGENT.md
