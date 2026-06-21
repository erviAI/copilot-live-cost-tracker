# Security Policy

## Supported versions

The latest released version on the VS Code Marketplace receives security fixes.

## Reporting a vulnerability

Please **do not** open a public issue for security vulnerabilities.

Instead, report them privately using GitHub's
[private vulnerability reporting](https://github.com/erviAI/cost-research/security/advisories/new)
for this repository. Include:

- A description of the issue and its impact.
- Steps to reproduce or a proof of concept.
- Any suggested remediation, if known.

You can expect an initial acknowledgement within a few business days. Once the
issue is confirmed and fixed, we will publish a release and credit the reporter
unless anonymity is requested.

## Scope and data handling

This extension reads local GitHub Copilot telemetry databases and log files to
compute usage costs. It does **not** transmit your data anywhere — all
processing happens locally within VS Code. Reports about data leaving the
machine, path traversal, or code execution via crafted database/log content are
especially welcome.
