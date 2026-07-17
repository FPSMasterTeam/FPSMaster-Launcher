---
name: launcher-error-logging
description: Add diagnostic, privacy-safe error logging at FPSMaster Launcher Tauri command boundaries.
disable-model-invocation: true
---

# Launcher Error Logging

## Rules

1. A Tauri command returning `Err(String)` does not automatically enter the UI log store; explicitly emit a sanitized diagnostic.
2. Process-spawn failures should include executable existence, size, working directory, platform and architecture, plus a human-readable OS error hint.
3. Centralize command-boundary logging so join failures and domain failures follow one format.
4. Apply equivalent boundary capture to synchronous commands when they otherwise return through scattered `?` operators.
5. Return a concise user-facing error while keeping bounded technical detail in the diagnostic log.
6. Remove tokens, personal paths, account identifiers and server addresses before logging.
