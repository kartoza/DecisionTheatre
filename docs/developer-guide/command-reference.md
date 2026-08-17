# Command Reference

Every task in the project has one name, reachable four ways:

| | |
|---|---|
| `dt <task>` | in any terminal — the primary spelling |
| `make <task>` | the same targets, if you prefer make |
| `<leader>p<key>` | in neovim |
| `nix run .#<task>` | for the tasks that must work without the development shell, which is what CI uses |

`dt` is a dispatcher rather than a second implementation: it reads the task list
from the Makefile's `.PHONY` lines, so it cannot offer a task that does not exist
nor miss one that was just added. A mistyped task suggests the closest real names.

```bash
dt                      # this table, in the terminal
dt <group>              # one group, with descriptions
dt <task>               # run it
dt run --port 9090      # extra flags reach the underlying tool
dt check-data DATA_DIR=/srv/data   # NAME=value reaches make as a variable
```

!!! tip "When a name is both a task and a group"
    `run`, `build`, `test`, `docs` and `release` name both. **The task wins**,
    because `dt test` should run the tests — that is what anyone typing it means.
    `dt help test` is the unambiguous form for the group. Names that are only
    groups — `develop`, `diagnose`, `flake`, `data` — need no such ceremony.

!!! note "This page is generated"
    The tables below are produced by calling `scripts/shell-help.sh` at build
    time — the same source that renders the greeting in `nix develop`, backs `dt`,
    and answers `make help`. Adding a command there makes it appear in all four
    places from one edit, which is the point: this page previously described the
    `make` targets long after `dt` had replaced them.

{{ dt_commands() }}

## Where the commands live

| Concern | Implementation |
|---|---|
| The list itself | `scripts/shell-help.sh` |
| Dispatch | `scripts/dt`, reading `.PHONY` from the `Makefile` |
| Launching the application | `scripts/run-app.sh` — every entry point, both modes |
| Deciding what to rebuild | `scripts/lib-build.sh`, shared by the launcher and the data tools |
| Terminal output | `scripts/lib-ui.sh`, shared by every reporting script |
| The shell environment | `scripts/dev-shell.sh`, sourced by the flake's `shellHook` |

The `nix run` entry points are documented in
[Development Environment](dev-environment.md#nix-run-commands); they exist for
the tasks CI needs to run without entering the development shell.
