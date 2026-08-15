# License

Decision Theatre is licensed under the **GNU General Public License v3.0** (GPL-3.0).

<figure markdown>
  ![Direct dependency counts per ecosystem](../assets/diagrams/generated/licences.svg)
  <figcaption class="gen">
    Counted from <code>go.mod</code> and <code>frontend/package.json</code> at build time.
  </figcaption>
</figure>


## What This Means

- You are free to use, modify, and distribute this software
- If you distribute modified versions, you must also release them under GPL-3.0
- You must include the original copyright notice and license text
- There is no warranty; the software is provided "as is"

## Full License Text

The complete license text is published at
[gnu.org/licenses/gpl-3.0](https://www.gnu.org/licenses/gpl-3.0.en.html).

!!! bug "No LICENSE file in the repository yet"
    GPL-3.0 is declared in `flake.nix` and `packaging/nfpm.yaml`, but the repository does
    not yet contain a `LICENSE` file, and source files do not carry SPDX headers. Until
    that is corrected, use the canonical text linked above.

    Ticket: *No LICENSE file and no SPDX headers, though GPL-3.0 is asserted in three
    manifests*.

## Third-Party Licenses

Decision Theatre depends on several open source libraries, each with their own license. See [Software Components](../developer-guide/components.md) for details.
