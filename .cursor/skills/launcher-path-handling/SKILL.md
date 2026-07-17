---
name: launcher-path-handling
description: Audit and implement safe launcher path handling for Unicode, spaces, placeholders, and Windows shell metacharacters.
disable-model-invocation: true
---

# Launcher Path Handling

## Guidance

- Spawn programs with argument arrays, never by concatenating a shell command.
- Keep each path as one argument token; let the platform process API handle Unicode and quoting.
- Drop an unresolved placeholder only when the entire token matches the placeholder syntax, not merely because it contains placeholder characters.
- Build classpaths as one platform-delimited argument.
- When a platform shell is unavoidable for “open with system”, quote paths explicitly and account for shell metacharacters.
- Legacy Java runtimes may fail on characters outside the local filesystem encoding; document this limitation rather than silently corrupting paths.
- Validate Windows-only code on Windows or CI.
