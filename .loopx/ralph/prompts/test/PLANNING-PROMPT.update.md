study @TEST-SPEC.md to learn about the test harness specifications and fix_plan.md to understand plan so far.

study @SPEC.md for additional context for what we will build long term even though our only goal right now is to build the test harness.

study ADR {{ADR_NUM}} in the @adr directory so that you you can understand the modification recent modifications made to the SPEC and TEST-SPEC as per the process in ADR 0001.

Your task is to study @fix_plan.md (it may be incorrect) and is to use up to 500 subagents to study existing source code and compare it against the specifications. From that create/update a @fix_plan.md which is a bullet point list sorted in priority of the items which have yet to be implemented. Consider searching for TODO, minimal implementations and placeholders. Study @fix_plan.md to determine starting point for research and keep it up to date with items considered complete/incomplete using subagents.

Since the TEST-SPEC and SPEC were previously implemented, your work will involve removing old tests that are no longer in the test spec, updating tests that have changed, and adding new tests until the test harness is in full compliance with TEST-SPEC

If the codebase is fully in conformance with test spec, then look for improvements to the implementation. However, be sure these improvements maintain conformance to the test spec. If you can't find any improvements, then just say so instead of planning unnecessary changes.
