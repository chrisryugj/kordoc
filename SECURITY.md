# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 4.7.x   | Yes |
| 4.5.x – 4.6.x | Security fixes only |
| < 4.5   | No |

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
| `kordoc watch --webhook <url>` | user-supplied URL | explicitly passed by the operator |

Set **`KORDOC_OFFLINE=1`** to block both *before the request is made*. This is a
single choke point (`src/shared/offline.ts`) — no other module calls `fetch`.
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
- ZIP decompression: 256MB cumulative (HWPX), 100MB (XLSX / DOCX)
- ZIP entries: 500 max
- HWP5 decompression: 100MB per stream; records 500,000 per section; sections 100 max
- HWP3 decompression: 100MB cumulative
- PDF: 5,000 pages, 100MB cumulative text
- Table dimensions: 200 cols × 10,000 rows (XLSX / markdown builder)
- MCP tool response capped at 200,000 characters

### Injection Prevention
- XXE / Billion Laughs: DOCTYPE fully stripped before XML parsing
- No `eval()` or `new Function()` anywhere
- No shell command construction from user input
- PDF JavaScript evaluation disabled (`isEvalSupported: false`)
- MCP error messages sanitized (no filesystem path leakage from non-`KordocError` failures)
- Hyperlink hrefs sanitized (`sanitizeHref`) on both parse and generate paths

### Path Traversal
- Broken ZIP recovery: backslash normalization, `..`, absolute paths, Windows drive letters all rejected
- ZIP entry filename length capped at 1,024 bytes
- MCP image directory reads accept bare filenames only (no separators, no `..`)

### Access Confinement (opt-in)
- **`KORDOC_ROOT=<dir>`** confines every MCP read and write to that directory subtree.
  Enforcement runs on the `realpath`-resolved path, so symlinks cannot escape it.
  Unset by default — existing behaviour is unchanged.

### Model Integrity
- OCR / formula models are pinned by SHA-256 in source; downloads are written to a
  `.part` file and verified before rename, and a mismatch deletes the file
- `kordoc models --import` applies the same verification to sideloaded bundles, so a
  tampered transfer medium cannot install a modified model

## Scope

kordoc is a **document parser library**, not a sandbox. It trusts the Node.js runtime
and its dependencies (cfb, jszip, @xmldom/xmldom, markdown-it, and — when OCR or PDF
features are used — pdfjs-dist, onnxruntime-node, sharp, @hyzyla/pdfium).
Vulnerabilities in these dependencies are outside kordoc's control but are addressed
via dependency updates.

`npm audit --omit=dev` reports **0 vulnerabilities** as of 4.7.2. One low-severity
advisory remains in `esbuild`, a build-time-only dependency of `tsup`/`tsx` that is
not part of the published package.

## Known Limitations

- HWPX format detection is ZIP-based (any ZIP file returns `"hwpx"` from `detectFormat`)
- Without `KORDOC_ROOT`, the MCP server can read any allowed-extension file on the
  filesystem. Air-gapped and multi-tenant deployments should always set it.
- `KORDOC_ROOT` confines the MCP server only. The CLI is assumed to run with the
  invoking user's own privileges, where a shell already grants equivalent access.
- Encrypted (password-protected) and DRM-wrapped HWP documents are rejected, not decrypted
