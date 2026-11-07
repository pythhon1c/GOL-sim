# Contributing

Use Python 3.11 or newer, Rust stable and Node.js 22 or newer. Follow the setup
instructions in README.md and run `./check.ps1` before proposing changes.

All state transitions must remain synchronous Conway B3/S23. Compare changes to
the native engine against the independent scalar reference tests. Cached or
guarded transitions must invalidate on every relevant boundary change. Rendering
and translations must never modify cells, generation counts or simulation rules.

Write code comments and developer documentation in English. Keep English,
Russian and Ukrainian UI dictionaries complete. Keep technical identifiers and
serialization formats language-independent; English is the default UI language.

Do not commit local configuration, checkpoints, logs, credentials, screenshots
of personal environments, virtual environments or compiled binaries. Add new
source files to `publication-files.json` before preparing a release.

Only submit third-party pattern data with a documented redistribution license,
author credit, source URL and the original cell state. Keep licenses separate.
New original contributions are submitted under the project's license unless a
different compatible license is explicitly agreed. You must have the rights to
submit your contribution. Commercial licensing inquiries go to
**ggggggdev@gmail.com**.
