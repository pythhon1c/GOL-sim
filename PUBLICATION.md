# Publication preparation

Publish the output of `tools/prepare_publication.py`, not the local installation. The exporter uses `publication-files.json` and `publication-policy.json` and produces SHA-256 and privacy reports. It refuses to overwrite an existing output folder. It does not create a remote repository, upload data or change a live simulation.

The developer supplied **ggggggdev@gmail.com** as a public contact. This is intentionally allowed by the privacy scan. Names in third-party credits identify publicly attributed authors, not local user data.

Excluded data includes `config.toml`, environment files, `.run`, checkpoints, personal run reports, unreviewed screenshots, virtual environments, toolchains, binaries, caches and Git history. Tests use sanitized deterministic fixtures under `tests/fixtures` instead of personal run reports.

The publication policy lists five media assets. Each has a review note and a
pinned SHA-256 digest.

| Path | Format | Maximum size |
| --- | --- | --- |
| `docs/images/monitor.jpg` | JPEG | 8 MiB |
| `docs/images/machines.jpg` | JPEG | 8 MiB |
| `docs/images/heatmap.jpg` | JPEG | 8 MiB |
| `docs/media/simulation-preview.gif` | GIF | 6 MiB |
| `docs/media/simulation.mp4` | MP4 | 12 MiB |

For a replacement, review the images or recording, any audio and the embedded
metadata for personal information. Update the digest and review note in
`publication-policy.json`. The exporter checks the format, size and digest at
these exact paths and preserves their bytes in the published tree.

The scanner checks common token/private-key forms, credential-bearing URLs, email addresses, user profile paths, private network addresses and local installation paths. Findings give relative paths, lines and categories without reproducing secret values. A clean scan is not proof that every possible personal datum is absent. The prepared tree inherits no Git history; later history and additions need their own review.

## Pattern distribution policy

The original software is PolyForm Noncommercial. Third-party licenses remain separate. The public catalog contains 59 entries: 49 small/conventional and attributed Lexicon entries, eight original logic cards, and two CC BY-SA Lexicon machine adaptations. All 36 Lexicon-derived entries, converted data and adapted catalog translations remain CC BY-SA 3.0.

Thirteen imports are excluded until redistribution permission is documented: the AM/PM digital clock, OTCA blinker, hexadecimal counter, constructor with memory loop, pi calculator, two-glider eater synthesis, spacefiller, Golly ticker, period-416 spaceship gun, blockstacker, Heisenburp, period-210 loafer gun and period-90 rake factory. Source links and credits remain in THIRD_PARTY.md; their RLE/JavaScript assets and catalog records are absent from the public bundle. A simulator's software license is not assumed to license every independently authored pattern.

The exporter deletes no local patterns. Confirmed permission can be added later with source evidence and a test update.

## Review before upload

Run tests from the prepared tree, inspect its file manifest and privacy report, and review the selected project name and copyright notice. GitHub Actions includes correctness and publication checks. Remote creation and upload are separate actions from the exporter. The intended repository description and topics are recorded in `.github/repository.json`.
