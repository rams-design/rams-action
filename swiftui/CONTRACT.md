# SwiftUI render lane: the action → worker contract (RAMS-461, v1)

The action renders on the customer's macOS runner and sends one request per
PNG. The worker (Linux, Cloud Run) never builds iOS code; it only judges
pixels.

## Request

`POST https://worker.rams.ai/v1/renders/swiftui`

Headers:

- `Authorization: Bearer rams_...`: the same workspace API key the action
  already sends to `/mcp` (input `api-key`, secret `RAMS_API_KEY`).
- `x-rams-source: github_action`
- `content-type: application/json`

Body (≤ 6 MB; the PNG itself ≤ 4 MB before base64):

```json
{
  "v": 1,
  "repo": "hsla0001/loop",
  "pr": 42,
  "sha": "4b1c0de",
  "file": "loop/ContentView.swift",
  "view": "Preview 1",
  "colorScheme": "light",
  "device": { "name": "iPhone 17 Pro", "width": 402, "height": 874, "scale": 3 },
  "png": "<base64>"
}
```

- `pr` is `null` outside pull_request runs. `sha` is the PR head (7 to 40 hex).
- `view` is the `#Preview("name")` label, `Preview N` for unnamed macros, the
  `PreviewProvider` type, or the `View` type for a bare `X()` render.
- `width`/`height` are points; the PNG is `width*scale` by `height*scale`.

## Response

Always JSON with an `outcome`:

| status | outcome | meaning |
| --- | --- | --- |
| 404 | (none) | lane off: `VISION_SWIFTUI` unset. The action logs `off`. |
| 401 | `unauthorized` | no or bad key (checked before the body is read) |
| 400 | `invalid` | shape, size, or not a PNG (`error` says which) |
| 403 | `workspace-not-allowed` | the key's workspace is not in `VISION_SWIFTUI_WORKSPACES` (required; unset refuses all) |
| 403 | `repo-not-allowed` | repo outside `VISION_SWIFTUI_REPOS` (default `hsla0001/`) |
| 200 | `judged` | shadow: judged and stored in `vision_shadow`, nothing returned |
| 200 | `busy` | another SwiftUI judge in flight; dropped, not queued |
| 200 | `judge-off` | `VISION_JUDGE` is not `on`; row stored without a verdict |
| 200 | `error` | judge or insert failed; logged on the worker |

Shadow returns no findings and no score: nothing reaches the customer.

## Storage (shadow)

One `vision_shadow` row per request, no migration:

- `review_context`: `swiftui:<repo>#<pr>@<sha7>:<file>:<view>:<colorScheme>`
- `render_status`: `rendered:swiftui:<device name>`
- `judge`: the `VisionVerdict` (or `{ error }`), `findings: []`, `facts_count: 0`

The PNG is not stored in v1.

## Flags (worker)

- `VISION_SWIFTUI`: unset or anything else = off (404 before auth); `shadow` =
  judge + store.
- `VISION_SWIFTUI_WORKSPACES`: comma-separated workspace ids that may spend
  judge calls. Required: `repo` is self-reported by the runner, so the key's
  workspace is what actually limits spend.
- `VISION_SWIFTUI_REPOS`: comma-separated repo prefixes allowed, default
  `hsla0001/`.
- `VISION_JUDGE`: the existing vision cost gate; not `on` stores the row with
  no verdict (`judge-off`).
