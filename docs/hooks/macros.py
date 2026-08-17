"""MkDocs macros: generate documentation from the scripts, on demand.

``scripts/shell-help.sh`` is the single place the project's commands are listed.
It renders the greeting on entering ``nix develop``, backs ``dt`` and
``dt <group>``, and answers ``make help``. Restating that list by hand in the
documentation gives it a fourth copy to fall out of step with — and it did: the
development guide described the ``make`` targets long after ``dt`` replaced them
as the primary spelling.

So the documentation calls the script instead::

    {{ dt_commands() }}          every group, as a table each
    {{ dt_commands("flake") }}   one group
    {{ dt_groups() }}            the group names, comma separated

Registered in ``mkdocs.yml`` as::

    plugins:
      - macros:
          module_name: docs/hooks/macros

A macro that cannot reach the script returns a visible admonition rather than
raising, because the Nix docs derivation may be given a narrower source tree than
a working checkout. ``mkdocs build --strict`` still fails on the warning, so the
site cannot quietly ship without its command reference.
"""

from __future__ import annotations

import logging
import os
import subprocess
from pathlib import Path

log = logging.getLogger("mkdocs.macros.dt")

SCRIPT = Path("scripts") / "shell-help.sh"


def _unavailable(reason: str) -> str:
    log.warning("dt command reference unavailable: %s", reason)
    return (
        '!!! warning "Command reference unavailable"\n'
        f"    This is generated from `{SCRIPT}`, which could not be read when\n"
        f"    this site was built ({reason}). Run `dt` in a checkout for the\n"
        "    current list.\n"
    )


def _run(*args: str) -> str | None:
    """Run the help script, returning its output or None on any failure."""
    if not SCRIPT.is_file():
        return None
    try:
        result = subprocess.run(
            ["bash", str(SCRIPT), *args],
            capture_output=True,
            text=True,
            timeout=30,
            check=True,
            # Inherit the environment so bash and coreutils are found wherever
            # the build runs; a hardcoded PATH does not survive Nix. Colour is
            # already off because stdout is not a terminal, and the icons are
            # suppressed because the site renders the groups as headings.
            env={**os.environ, "DT_HELP_ICONS": "0", "TERM": "dumb"},
        )
    except (OSError, subprocess.SubprocessError) as exc:
        log.warning("%s %s failed: %s", SCRIPT, " ".join(args), exc)
        return None
    return result.stdout


def define_env(env):
    """Register the macros. Called by mkdocs-macros at build time."""

    @env.macro
    def dt_commands(group: str = "") -> str:
        """The command table as markdown — every group, or just one."""
        if not SCRIPT.is_file():
            return _unavailable(f"{SCRIPT} is not in the source tree")

        args = ["--markdown"] if not group else ["--markdown", group]
        out = _run(*args)
        if out is None:
            return _unavailable("the script could not be run")

        body = out.strip()
        if not body:
            return _unavailable(f"no commands returned for {group or 'any group'}")

        log.info(
            "dt_commands(%r): %d groups from %s",
            group or "all",
            body.count("### ") or 1,
            SCRIPT,
        )
        return body

    @env.macro
    def dt_groups() -> str:
        """The group names, for prose that lists them."""
        out = _run("--groups")
        if not out:
            return "run `dt` for the list"
        return ", ".join(f"`{g}`" for g in out.split())
