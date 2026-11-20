# Typefaces

These are committed rather than fetched. The desktop application is offline by design, so
a request to a font CDN either fails or blocks first paint, and it announces every launch
to a third party. Committing them also means the desktop application and the hosted
dashboard render identically.

Refresh with `dt vendor-fonts`; verify with `dt vendor-fonts --check`. Both take the files
from nixpkgs, so the provenance is a package attribute rather than a URL somebody pasted
once. Do not edit or replace these files by hand.

| File | Family | Source | Licence |
|---|---|---|---|
| `InterVariable.woff2` | Inter | nixpkgs `inter` | OFL-1.1 |
| `InterVariable-Italic.woff2` | Inter | nixpkgs `inter` | OFL-1.1 |
| `SourceSans3VF-Upright.woff2` | Source Sans 3 | nixpkgs `source-sans` | OFL-1.1 |
| `SourceSans3VF-Italic.woff2` | Source Sans 3 | nixpkgs `source-sans` | OFL-1.1 |

All four are variable fonts: one file spans the whole weight axis, which is why
`fonts.css` declares a single `@font-face` per style rather than one per weight.

## Licensing

Both families are under the SIL Open Font License 1.1, which permits bundling and
redistribution — including inside a proprietary application — provided the licence
travels with them and the fonts are not sold on their own.

`SPDX-License-Identifier: OFL-1.1`

- Inter — <https://github.com/rsms/inter>, Copyright (c) 2016 The Inter Project Authors
- Source Sans 3 — <https://github.com/adobe-fonts/source-sans>, Copyright (c) 2010–2023
  Adobe Systems Incorporated

The full OFL-1.1 text is vendored at `/LICENSES/OFL-1.1.txt`, and each `.woff2` here is
mapped to it (and to its real copyright holder, not Kartoza's) in the repository root's
`REUSE.toml` — binary font files can't carry an inline comment header the way source
files do.
