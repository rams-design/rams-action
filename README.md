# Rams GitHub Action

Automated design reviews on every PR: accessibility, visual consistency, anti-slop detection.

## Quick Start

Add this workflow to your repo:

```yaml
# .github/workflows/rams.yml
name: Rams

on:
  pull_request:
    branches: [main]

jobs:
  review:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
    
    steps:
      - uses: actions/checkout@v4
      
      - uses: rams-ai/rams-action@v1
        with:
          api_key: ${{ secrets.RAMS_API_KEY }}
```

That's it! Rams automatically:
- **First PR**: Full audit of your codebase, establishes baseline
- **Subsequent PRs**: Reviews only changed files, shows score delta

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
| `mode` | `fast` (two-pass) or `thorough` (every file) | No | `fast` |
| `changed_only` | Only review files changed in PR | No | `true` |
| `fail_on_critical` | Fail if critical issues found | No | `true` |

## Outputs

| Output | Description |
|--------|-------------|
| `score` | Design score (0-100) |
| `issues` | Number of issues found |
| `critical` | Number of critical issues |
| `serious` | Number of serious issues |
| `moderate` | Number of moderate issues |

## Example PR Comment

---

## Rams Design Review

| Metric | Value |
|--------|-------|
| **Score** | 72/100 (+8 ✅) |
| **Baseline** | 64/100 |
| 🔴 Critical | 2 |
| 🟠 Serious | 5 |
| 🟡 Moderate | 8 |

### 🔴 Critical Issues

#### `A11Y-002` Button missing accessible name
> 📁 `src/components/Button.tsx:45`

<details><summary>View fix</summary>

**Current:**
```jsx
<button>
  <svg>...</svg>
</button>
```

**Fix:**
```jsx
<button aria-label="Close menu">
  <svg aria-hidden="true">...</svg>
</button>
```
</details>

### 🟢 What's Done Well

| Rule | Observation |
|------|-------------|
| `COMP-004` | Consistent use of cn() utility |
| `TYPE-001` | Typography uses Tailwind scale |

---

## How It Works

### First PR (Automatic)
- Rams detects no baseline exists
- Runs a **full audit** of your entire codebase
- Establishes your baseline score
- Saves to your account

### Subsequent PRs
- Only reviews files changed in the PR
- Compares against your baseline
- Shows score delta: `+5 ✅` or `-3 ⚠️`
- Lists new issues and fixed issues

## What It Checks

### 🔴 Critical (Accessibility)
- Missing alt text on images
- Buttons/links without accessible names
- Form inputs without labels
- Insufficient color contrast
- Missing focus indicators

### 🟠 Serious (Design Quality)
- Hardcoded hex colors instead of tokens
- Mixed gray scales (zinc/slate/gray)
- Non-semantic HTML elements
- Missing TypeScript types

### 🟡 Moderate (Anti-Slop)
- Purple gradients (AI-generated patterns)
- Glow effects and excessive shadows
- rounded-3xl overuse
- Lorem ipsum placeholder text

## Modes

### Fast Mode (default)
Two-pass review: quick triage of all files, then detailed review of problem files only.
- Best for: Daily CI/CD on PRs

### Thorough Mode
Reviews every file individually for maximum detection.
- Best for: Pre-release reviews, audits

```yaml
- uses: rams-ai/rams-action@v1
  with:
    api_key: ${{ secrets.RAMS_API_KEY }}
    mode: thorough
```

## Support

- [Documentation](https://rams.ai/docs)
- [Email](mailto:support@rams.ai)
