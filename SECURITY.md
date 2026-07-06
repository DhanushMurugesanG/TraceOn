# Security Policy

## Supported Versions

TraceOn is in alpha. Security fixes are applied to the latest released version
only.

| Version | Supported          |
| ------- | ------------------ |
| 0.2.x   | :white_check_mark: |
| < 0.2   | :x:                |

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

Instead, use one of these private channels:

- Open a [private security advisory](https://github.com/DhanushMurugesanG/TraceOn/security/advisories/new)
  (preferred), or
- Email **dhanushmarch@gmail.com** with the details.

Please include:

- A description of the vulnerability and its impact
- Steps to reproduce (a proof of concept if possible)
- Any suggested remediation

You can expect an acknowledgement within **72 hours**. We'll keep you informed
as we work on a fix and will credit you in the release notes unless you prefer
to remain anonymous.

## Scope

TraceOn runs Playwright tests, downloads and executes an embedded OTel
Collector, and reads/writes local trace data. Reports touching any of the
following are especially valued:

- Arbitrary code execution via crafted test files or config
- Path traversal or unsafe file writes during `traceon init` / collector
  download
- Exfiltration of trace data or credentials to an unexpected destination
- Integrity of the collector binary download (checksum/signature bypass)
