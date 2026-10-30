# Rams Design Review: the judge in your agent loop

Score UI changes 0–100, emit structured findings and **git-applyable
patches**, and gate merges on critical design defects. Rams judges; your
tools repair.

## PR gate

```yaml
- uses: actions/checkout@v4
  with: { fetch-depth: 0 }
- uses: rams-design/rams-action@v1
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
        uses: rams-design/rams-action@v1
        with:
          api-key: ${{ secrets.RAMS_API_KEY }}
          mode: since-last-run              # reviews only what changed since the last run
          fail-on: never
      # hand the findings to YOUR agent step (Claude Code, Codex, anything):
      #   rams-review/issues.json: structured findings
      #   rams-review/patches/: git-applyable fixes
      # then commit .rams/last-reviewed-ref to advance the window
```

## SwiftUI renders (preview, our repos first)

A second job on a macOS runner renders the SwiftUI previews of the files a PR
changes and sends the PNGs to Rams. It builds your app for the iOS Simulator
on your runner; nothing in your project changes and nothing is committed.

```yaml
  swiftui-renders:
    runs-on: macos-15
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: rams-design/rams-action@v1
        with:
          api-key: ${{ secrets.RAMS_API_KEY }}
          render-swiftui: true
      - uses: actions/upload-artifact@v4
        with: { name: rams-renders, path: rams-review/renders }
```

What renders: each `#Preview` and `PreviewProvider` in changed files under
your app's source folder, at full iPhone size, light and dark. A changed file
with no previews renders its views that build with no arguments. A preview
that will not build outside Xcode is dropped and listed, never fatal.
Contract: [swiftui/CONTRACT.md](swiftui/CONTRACT.md).

## Outputs

| output | meaning |
| --- | --- |
| `score` | 0–100 (any confirmed critical caps at 59) |
| `critical-count` | confirmed criticals |
| `issues-json` | path to structured findings |
| `patches-dir` | one `.patch` per unambiguous fix, ready for `git apply` |

Quota: each run consumes one review (shared with the GitHub App and MCP).
Engine: the same rules as every Rams surface (live list at [rams.ai/rules](https://www.rams.ai/rules)). Setup and plans: [rams.ai/action](https://www.rams.ai/action).
