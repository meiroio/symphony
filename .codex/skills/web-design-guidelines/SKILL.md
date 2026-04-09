---
name: web-design-guidelines
description: "Audit UI code against Vercel's Web Interface Guidelines for design, accessibility, and UX compliance. Use when the user asks for design review, UI review, accessibility review, frontend audit, or wants changed UI files checked against the latest Vercel guidelines."
---

# Web Interface Guidelines

Review UI-facing files for compliance with Web Interface Guidelines.

## How It Works

1. Fetch the latest guidelines from the source URL below before each review.
2. Read the specified files or file patterns.
3. Check the files against all rules in the fetched guidelines.
4. Output findings in terse `file:line` format.

## Guidelines Source

Fetch fresh guidelines before each review:

`https://raw.githubusercontent.com/vercel-labs/web-interface-guidelines/main/command.md`

Use `WebFetch` when it is available. If browsing tooling is unavailable but shell network access exists, use `curl -fsSL`.

## Scope

When reviewing a diff, default to changed UI-facing files such as:

- `*.tsx`
- `*.jsx`
- `*.ts`
- `*.js`
- `*.css`
- `*.scss`
- `*.html`
- `*.mdx`
- any other file that clearly changes user-visible UI behavior

If no UI-facing files are in scope, return `SKIPPED` with a one-line reason instead of manufacturing findings.

## Usage

When file paths or patterns are provided:

1. Fetch guidelines from the source URL above.
2. Read the specified files.
3. Apply all fetched rules.
4. Output findings using the format specified by the fetched guidelines.

If no files are specified, ask which files or patterns to review.

## Output

- Group by file.
- Use `file:line` format.
- Keep findings terse.
- Skip preamble.
- If a file passes, report `✓ pass`.
- If the review is not applicable, report `SKIPPED`.
