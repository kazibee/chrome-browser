# Chrome Browser Package Documentation

This directory contains technical documentation for the chrome-browser package.

## Available Documentation

### [Coordinate System Investigation](./coordinate-system-investigation.md)

**Status**: ⚠️ Critical - Action Required

Comprehensive investigation into why screenshot pixel coordinates and DOM coordinate lookups sometimes didn't match. The investigation reveals that the issue had multiple root causes, not just Device Pixel Ratio (DPR) mismatch.

**Key Findings**:
- 4 root causes identified (sparse sampling, DPR mismatch, API limitations, token fragility)
- Current fix addresses 2/4 causes
- 5 critical vulnerabilities remain unfixed (CSS zoom, shadow DOM, CSS transforms, position:fixed, performance)
- 16 regression risks documented

**Audience**: Developers working on coordinate-related code, QA engineers writing tests, architects planning improvements

**Last Updated**: 2026-02-09

---

## Contributing to Documentation

When adding new documentation:

1. **Create markdown files** in this directory
2. **Add entry to this README** with brief description and audience
3. **Include date stamps** for version tracking
4. **Link to related code** with file paths and line numbers
5. **Provide examples** where applicable

## Documentation Standards

- **Format**: GitHub-flavored Markdown
- **Code blocks**: Include language identifier for syntax highlighting
- **Links**: Use relative paths for internal links
- **Status indicators**: Use emoji for visual clarity (✅ 🔴 ⚠️)
- **Audience**: Specify intended audience at top of document
- **Updates**: Include "Last Updated" date

## Useful Links

- **Main Package**: [chrome-browser](../README.md)
- **Source Code**: [src/](../src/)
- **CDP Bridge**: [src/cdp-bridge.mjs](../src/cdp-bridge.mjs)
- **Chrome Client**: [src/chrome-client.ts](../src/chrome-client.ts)
