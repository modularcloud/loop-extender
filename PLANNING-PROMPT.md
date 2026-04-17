study @SPEC.md and @TEST-SPEC.md to learn about the what we are building and fix_plan.md to understand plan so far.

Your task is to study @fix_plan.md (it may be incorrect) and is to use up to 500 subagents to study existing source code and compare it against the specifications. From that create/update a @fix_plan.md which is a bullet point list sorted in priority of the items which have yet to be implemented. Consider searching for TODO, minimal implementations and placeholders. Study @fix_plan.md to determine starting point for research and keep it up to date with items considered complete/incomplete using subagents.

If the codebase is fully in conformance with spec, then look for improvements to the implementation. However, be sure these improvements maintain conformance to the spec. If you can't find any improvements, then just say so instead of planning unnecessary changes.

tip: a recent update the codebase was the implementation of the tests for ADR 0003 as per the process of ADR 0001 in the @adr directory. so you may find that some of ADR 3's intended changes are not yet properly implemented (but remember @SPEC.md is the source of truth not ADR 0003) which could result in spec conformance issues and failing tests. on the other hand, it might be implemented so dont make assumptions about if it is implemented or not
