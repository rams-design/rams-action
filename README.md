# Rams GitHub Action

Automated design reviews: accessibility, visual consistency, anti-slop.

## Quick Start

```yaml
name: Design Review

on:
  pull_request:
    branches: [main]

jobs:
  design-review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      
      - uses: rams-ai/rams-action@v1
        with:
          api_key: ${{ secrets.RAMS_API_KEY }}
```

## Get Your API Key

1. Sign up at [rams.ai](https://rams.ai)
2. Go to Account → API Keys
3. Create a new key
4. Add it to your repo secrets as `RAMS_API_KEY`

## Inputs

| Input | Description | Required | Default |
|-------|-------------|----------|---------|
| `api_key` | Rams API key | Yes | - |
| `path` | Path to audit | No | `src` |
| `fail_on_critical` | Fail if critical issues found | No | `true` |

## Outputs

| Output | Description |
|--------|-------------|
| `score` | Design score (0-100) |
| `issues` | Number of issues found |
| `critical` | Number of critical issues |

## Example Output

The action adds a summary to your PR:

| Metric | Value |
|--------|-------|
| **Score** | 72/100 |
| **Issues** | 5 |
| **Critical** | 2 |

### Issues

#### Critical
- 🔴 **Missing focus states on buttons** — `Button.tsx`
- 🔴 **Touch target too small** — `NavBar.tsx`

#### Moderate
- 🟡 Raw hex colors instead of tokens — `Card.tsx`
- 🟡 Arbitrary spacing values — `Header.tsx`

<details><summary>Low priority (1)</summary>

- ⚪ Generic hover effect (PricingCard.tsx)
</details>

## What It Checks

Rams reviews your code for design quality across:

### Critical (blocks merge)
- Missing focus states on interactive elements
- Touch targets under 44x44px
- Missing alt text on images
- Contrast failures
- No keyboard navigation

### Moderate
- Raw hex/rgb colors instead of design tokens
- Arbitrary spacing values (e.g., `p-[23px]`)
- Multiple font imports
- Inconsistent button styles

### Low (suggestions)
- Purple gradients (AI slop indicator)
- `hover:scale-105` (generic effect)
- Emoji as icons
- "MOST POPULAR" badges

## Pricing

| Plan | Price | Features |
|------|-------|----------|
| Free | $0 | Rams Skill (in-editor feedback) |
| Team | $49/mo | CI/CD Action, unlimited PRs |

## Support

- [Documentation](https://rams.ai/docs)
- [Email](mailto:rams@rams.ai)
