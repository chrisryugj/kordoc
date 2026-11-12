# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 4.21.x  | Yes |
| < 4.21  | No — upgrade to the latest 4.21.x |

## Reporting a Vulnerability

If you discover a security vulnerability in kordoc, please report it responsibly:

1. **Do NOT open a public GitHub issue** for security vulnerabilities
2. Email: **chrisryugj@gmail.com** with subject `[kordoc security]`
3. Include:
   - Description of the vulnerability
   - Steps to reproduce (crafted file, input, etc.)
   - Potential impact assessment
   - Suggested fix (if any)

### Response Timeline

This is a solo-maintained project. Timelines are best-effort:

- **Acknowledgement**: Best effort, typically within 1 week
- **Initial assessment**: Within 2 weeks
- **Fix release**: Depends on severity and complexity. Critical issues are prioritized but no SLA is guaranteed

## Outbound Network Traffic

kordoc is a document parser. Parsing, generating, patching, and rendering documents
never touch the network. Only two code paths make outbound requests, both opt-in:

| Path | Destination | Trigger |
|------|-------------|---------|
| OCR / formula model download (first run only) | `huggingface.co` | OCR features enabled, models not yet cached |
| `kordoc watch --webhook <url>` | user-supplied URL | explicitly passed by the operator. The payload carries the file name, format and, for Markdown output, the first 1,000 characters of the converted text |

Set **`KORDOC_OFFLINE=1`** to block both *before the request is made*. This is a
single choke point (`src/shared/offline.ts`) — no other module calls `fetch`.
Printing and PDF rendering disable page JavaScript and block every request except
`data:` and `about:` through the shared `launchLockedPage` helper, regardless of
`KORDOC_OFFLINE`. External images, stylesheets and fonts are therefore not fetched.
Chromium runs with its sandbox on. It is turned off only on Linux when running as
root, where Chromium refuses to start sandboxed, or when `KORDOC_CHROMIUM_NO_SANDBOX=1`
is set.
Model downloads stop if the response grows well past the model's expected size.
Webhook targets that resolve to loopback, private, link-local, CGNAT, benchmark,
documentation, multicast or reserved ranges, IPv4 or IPv6, are refused.
See [docs/offline-deployment.md](docs/offline-deployment.md) for air-gapped deployment.

## Security Measures

kordoc processes untrusted binary files. The following defenses are in place:

### Input Validation
- Magic byte format detection (4-byte minimum guard)
- File size limit: 500MB (CLI, MCP server, watch mode)
- Extension allowlist in MCP server: `.hwp`, `.hwpx`, `.hml`, `.pdf`, `.xls`, `.xlsx`, `.docx`
  (parsing tools additionally accept `.png`, `.jpg`, `.jpeg`, `.webp` for OCR input)
- Symlink resolution via `realpathSync` before any read or write

### Resource Limits
- ZIP decompression: 256MB cumulative (HWPX), 100MB (XLSX / DOCX). Every ZIP entry in every
  format is decompressed as a stream. It stops as soon as it exceeds the size the archive
  declares for it, and the pre-check sums the larger of the central-directory and
  local-header sizes. Forging either size cannot get past the cumulative limit.
- Compressed PNG text chunks scanned by redaction: 16MB each
- ZIP entries: 500 max
- HWP5 decompression: 100MB per stream; records 500,000 per section; sections 100 max
- HWP3 decompression: 100MB cumulative
- PDF: 5,000 pages, 100MB cumulative text
- Spreadsheet tables: 2,000,000-cell budget; the row limit depends on column count, with truncation warnings. Markdown builder: 200 cols × 10,000 rows
- MCP tool response capped at 200,000 characters

### Injection Prevention
- XXE / Billion Laughs: DOCTYPE fully stripped before XML parsing
- No `eval()` or `new Function()` anywhere
- No shell command construction from user input
- PDF JavaScript never runs: the PDF engine (hayro, a bundled WebAssembly build) has no JavaScript interpreter
- HTML table-cell text escaped; Chromium printing/rendering disables JavaScript and external requests
- `htmlTables` output keeps only kordoc's own `<br>`, `<u>`, `<sup>`, `<sub>` and image tags in cells. Any
  other tag from a document, such as `<img onerror>`, is escaped
- `htmlCellLinks` (off by default) adds `<a href>` in HTML table cells only for `http:`, `https:`, `mailto:`,
  `tel:` and `#` addresses; the attribute value is escaped and the print renderer allows only that form
- Markdown output escapes link syntax written in document text. `[x](javascript:…)` and `[x]: url`
  definitions do not become links. Code-span fences are longer than any backtick run inside them
- Layout HTML (`render --format html`) carries a Content-Security-Policy that forbids scripts and external loads
- Document colours reach SVG attributes only as `#RRGGBB`
- The Windows COM fallback for DRM documents passes the file path to PowerShell
  through an environment variable, never inside the script text
- Extracted image assets keep image extensions only (others become `.bin`). SVG images
  carrying scripts or event attributes are not written as `.svg`
- MCP error messages sanitized (no filesystem path leakage from non-`KordocError` failures)
- Hyperlink hrefs sanitized (`sanitizeHref`) on both parse and generate paths

### Path Traversal
- Broken ZIP recovery: backslash normalization, `..`, absolute paths, Windows drive letters all rejected
- ZIP entry filename length capped at 1,024 bytes
- CLI/MCP image directory reads support Unicode and URL-encoded relative paths;
  each resolved file must remain inside the resolved image directory, including
  symlink targets. MCP also checks `KORDOC_ROOT`.

### Access Confinement (opt-in)
- MCP write tools never write into hidden paths (a folder or file starting with `.`, such as
  `.claude`, `.ssh` or `.mcp.json`). They also refuse agent instruction files (`CLAUDE.md`,
  `AGENTS.md`, `GEMINI.md`, `copilot-instructions.md`, `mcp.json`). A prompt injected through
  a received document therefore cannot plant instructions for later sessions.
- **`KORDOC_ROOT=<dir>`** confines every MCP read and write to that directory subtree.
  Enforcement resolves existing ancestors with `realpath`; write targets that are
  symlinks are rejected, including when parent directories do not yet exist.
  Unset by default — existing behaviour is unchanged.

### Process Isolation (opt-in, Linux)
- kordoc can run inside [gVisor](https://gvisor.dev/). A memory bug in a native dependency
  (sharp, onnxruntime, PDF engines) triggered by a crafted document then reaches only the
  gVisor kernel, not the host kernel, files or network.
- Container runtime: `docker run --runtime=runsc --network=none`, or a Kubernetes
  RuntimeClass with handler `runsc`. No code change.
- **`KORDOC_SANDBOX=gvisor`** re-runs the parsing CLI and `parse-worker` (Java/Python SDK)
  inside `runsc do` with networking off and `KORDOC_OFFLINE=1`. Host files are read-only;
  writes stay in memory, so only stdout parsing is accepted. On Linux it fails if runsc cannot
  start and never continues unsandboxed. On macOS and Windows, where gVisor cannot run, it
  prints a warning and runs without isolation. Unset by default — existing behaviour is unchanged.
- CI runs the test suite inside gVisor and checks that isolation is really on. See
  [docs/sandbox.md](docs/sandbox.md).

### Model Integrity
- OCR / formula models are pinned by SHA-256 in source; downloads are written to a
  `.part` file and verified before rename, and a mismatch deletes the file
- `kordoc models --import` applies the same verification to sideloaded bundles, so a
  tampered transfer medium cannot install a modified model

## Scope

kordoc is a **document parser library**, not a sandbox. It trusts the Node.js runtime
and its dependencies (cfb, jszip, markdown-it, the bundled quick-xml and hayro WebAssembly builds,
and — when OCR features are used — onnxruntime-node, sharp).
Vulnerabilities in these dependencies are outside kordoc's control but are addressed
via dependency updates.

`npm audit` reports **0 vulnerabilities** in both runtime and development dependencies
as of 4.21.30 (2026-10-13). The publish gate (`prepublishOnly`) runs `scripts/check-licenses.mjs`,
which fails if any runtime or optional dependency carries a licence outside a permissive
allowlist (MIT, ISC, Apache-2.0, BSD and similar) or none at all. `npm run sbom` writes a
CycloneDX SBOM (`sbom.cdx.json`). `kordoc setup` registers the MCP server pinned to the
installed version (`npx -y kordoc@<version>`) rather than the latest release. GitHub
Actions workflows pin every action to a commit SHA.

## Known Limitations

- HWPX format detection is ZIP-based (any ZIP file returns `"hwpx"` from `detectFormat`)
- Without `KORDOC_ROOT`, the MCP server can read any allowed-extension file on the
  filesystem. Air-gapped and multi-tenant deployments should always set it.
- `KORDOC_ROOT` confines the MCP server only. The CLI is assumed to run with the
  invoking user's own privileges, where a shell already grants equivalent access.
- Encrypted (password-protected) and DRM-wrapped HWP documents are rejected, not decrypted
