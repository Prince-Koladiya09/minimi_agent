# Suggested 3-day commit plan (10 commits per day)

This file is a truthful implementation plan, not fabricated Git history. Make each commit after
the corresponding change is complete and tested. Do not backdate commits or create empty commits
to simulate activity. GitHub will record the real author and timestamp.

## Day 1 — foundation (10 commits)
1. `chore: scaffold JavaScript Node project`
2. `chore: add environment validation and config`
3. `feat: add Express server and static chat shell`
4. `feat: add chat composer and conversation UI`
5. `feat: add SSE transport`
6. `feat: add OpenAI client integration`
7. `feat: define web_search tool schema`
8. `feat: add Tavily search adapter`
9. `feat: add search timeout and result limits`
10. `docs: document local setup and environment`

## Day 2 — memory and temporal reasoning (10 commits)
1. `feat: add SQLite schema`
2. `feat: persist conversations and messages`
3. `feat: add FTS5 message index`
4. `feat: implement temporal resolver`
5. `test: cover weekday and calendar date resolution`
6. `feat: retrieve memory by date window`
7. `feat: retrieve relevant memory with FTS5`
8. `feat: add structured claims ledger`
9. `feat: extract claims asynchronously`
10. `feat: inject bounded memory into agent context`

## Day 3 — reliability and submission (10 commits)
1. `feat: parallelize independent search calls`
2. `feat: add bounded agent loop`
3. `feat: add search response cache`
4. `feat: add source IDs and citations`
5. `fix: handle search failures gracefully`
6. `test: add temporal memory evaluation scenarios`
7. `ci: add GitHub Actions verification workflow`
8. `docs: add architecture and sequence diagrams`
9. `docs: write design rationale and trade-offs`
10. `chore: verify clean install and submission checklist`

Suggested cadence: spread the work across three actual working days. The ZIP cannot create
future commits or guarantee a GitHub contribution schedule; the repository owner must make and
push these commits.
