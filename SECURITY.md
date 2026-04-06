# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 1.8.x   | Yes       |
| 1.7.x   | Security fixes only |
| < 1.7   | No        |

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

## Security Measures

kordoc processes untrusted binary files. The following defenses are in place:

### Input Validation
- Magic byte format detection (4-byte minimum guard)
- File size limit: 500MB (CLI and MCP server)
- Extension allowlist in MCP server (`.hwp`, `.hwpx`, `.pdf`, `.xlsx`, `.docx`)
- Symlink resolution via `realpathSync`

### Resource Limits
- ZIP decompression: 100MB cumulative limit
- ZIP entries: 500 max
- HWP5 decompression: 100MB per stream, 100MB cumulative
- HWP5 records: 500,000 max per section
- HWP5 sections: 100 max
- PDF pages: 5,000 max
- PDF text: 100MB cumulative limit
- Table dimensions: 200 cols, 10,000 rows

### Injection Prevention
- XXE/Billion Laughs: DOCTYPE fully stripped before XML parsing
- No `eval()` or `new Function()` anywhere
- No shell command construction from user input
- PDF JavaScript evaluation disabled (`isEvalSupported: false`)
- MCP error messages sanitized (allowlist-based, no path leakage)

### Path Traversal
- Broken ZIP recovery: backslash normalization, `..`, absolute paths, Windows drive letters all rejected
- ZIP entry filename length capped at 1,024 bytes

## Scope

kordoc is a **document parser library**, not a sandbox. It trusts the Node.js runtime and its dependencies (cfb, jszip, pdfjs-dist, @xmldom/xmldom). Vulnerabilities in these dependencies are outside kordoc's scope but will be addressed via dependency updates.

## Known Limitations

- `cfb` is bundled via `noExternal` — users cannot independently update it
- HWPX format detection is ZIP-based (any ZIP file returns `"hwpx"` from `detectFormat`)
- MCP server has no directory restriction by default (any `.hwp`/`.hwpx`/`.pdf`/`.xlsx`/`.docx` on the filesystem can be read)
