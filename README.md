# Rams Design Review — the judge in your agent loop

Score UI changes 0–100, emit structured findings and **git-applyable
patches**, and gate merges on critical design defects. Rams judges; your
tools repair.

## PR gate

```yaml
- uses: actions/checkout@v4
  with: { fetch-depth: 0 }
- uses: hsla0001/rams-action@v1
  with:
    api-key: ${{ secrets.RAMS_API_KEY }}   # free at rams.ai/app/settings
    fail-on: critical                       # or score<80, or never
```

## The loop (scheduled, agents repair)

```yaml
on:
  schedule: [{ cron: '0 9 * * 1,4' }]      # Mon + Thu
jobs:
  design:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - id: rams
        uses: hsla0001/rams-action@v1
        with:
          api-key: ${{ secrets.RAMS_API_KEY }}
          mode: since-last-run              # reviews only what changed since the last run
          fail-on: never
      # hand the findings to YOUR agent step — Claude Code, Codex, anything:
      #   rams-review/issues.json  — structured findings
      #   rams-review/patches/     — git-applyable fixes
      # then commit .rams/last-reviewed-ref to advance the window
```

## Outputs

| output | meaning |
| --- | --- |
| `score` | 0–100 (any confirmed critical caps at 59) |
| `critical-count` | confirmed criticals |
| `issues-json` | path to structured findings |
| `patches-dir` | one `.patch` per unambiguous fix — `git apply` ready |

Quota: each run consumes one review (shared with the GitHub App and MCP).
Engine: the same 291-rule judge as every Rams surface — [rams.ai](https://www.rams.ai).
