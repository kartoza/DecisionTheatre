-- Decision Theatre — project-local neovim configuration.
--
-- Loaded automatically when neovim starts in this directory, provided you have
-- `vim.o.exrc = true` in your own config (neovim will ask you to trust this
-- file the first time; `:trust` accepts it).
--
-- Every mapping shells out to the Makefile, which in turn calls
-- scripts/run-app.sh for anything that launches the application. That keeps
-- neovim, `make run` and `nix run` on one single source of truth — editing the
-- script changes all three at once.

-- Resolve the project root from this file's own path rather than the cwd, so
-- the mappings keep working after `:cd` into a subdirectory.
local root = vim.fn.fnamemodify(debug.getinfo(1, "S").source:sub(2), ":p:h")

--- Run a shell command in a terminal split rooted at the project directory.
--- @param cmd string command to execute
local function project_cmd(cmd)
  vim.cmd("botright split")
  vim.cmd("resize 15")
  vim.fn.termopen({ "bash", "-lc", cmd }, { cwd = root })
  vim.cmd("startinsert")
end

-- <leader>p<key> — project commands. Descriptions are picked up by which-key
-- automatically; no which-key dependency is required for the mappings to work.
local mappings = {
  -- Run: the canonical way to launch the app, in either mode.
  { "r", "make run", "Run the desktop app" },
  { "s", "make serve", "Run as a web server (no window)" },
  { "R", "make run DT_FORCE_BUILD=1", "Run (force full rebuild)" },
  { "n", "nix run", "Run via nix (reproducible build)" },

  -- Build
  { "b", "make app", "Build everything (frontend + docs + backend)" },
  { "c", "make clean", "Clean build artifacts" },

  -- Hot-reload development
  { "h", "make dev-all", "Hot reload: Go + Vite HMR" },

  -- Quality and health
  { "t", "make test-all", "Test (Go + frontend)" },
  { "l", "make lint", "Lint" },
  { "f", "make fmt", "Format" },
  { "g", "make fmt-check", "Is everything gofmt-clean? (what CI asks first)" },
  { "V", "make vet", "go vet (the hook's stand-in for the full linter)" },
  { "C", "make check-shell", "shellcheck every shell script" },
  { "N", "make check-nix", "Is flake.nix nixpkgs-fmt formatted?" },
  { "G", "make check-secrets", "gitleaks over the whole history" },
  { "D", "make check-drift", "Has the data contract drifted?" },
  { "k", "make check", "Check (fmt-check + lint + test)" },
  { "?", "make doctor", "Doctor: is this checkout healthy?" },

  -- Flake lock step — a stale hash breaks every importer of this flake
  { "F", "make check-flake", "Is flake.nix in step with the manifests?" },
  { "S", "make sync-flake", "Recompute the nix hashes and record them" },

  -- Docs and data
  { "d", "make docs-serve", "Serve documentation" },
  { "v", "make check-data", "Check the data directory" },
  { "p", "make pack-data", "Check, then build a data pack" },

  -- The command table itself
  { "H", "dt", "Show the command table" },
}

for _, m in ipairs(mappings) do
  local key, cmd, desc = m[1], m[2], m[3]
  vim.keymap.set("n", "<leader>p" .. key, function()
    project_cmd(cmd)
  end, { buffer = false, silent = true, desc = desc })
end

-- Label the <leader>p group when which-key is installed.
local ok, which_key = pcall(require, "which-key")
if ok then
  -- which-key v3 uses the list spec; v2 uses the table spec.
  if which_key.add then
    which_key.add({ { "<leader>p", group = "Project (Decision Theatre)" } })
  else
    which_key.register({ ["<leader>p"] = { name = "Project (Decision Theatre)" } })
  end
end

-- Project conventions: Go uses tabs, everything else two spaces.
vim.api.nvim_create_autocmd("FileType", {
  pattern = { "typescript", "typescriptreact", "javascript", "json", "yaml", "nix", "lua" },
  callback = function()
    vim.bo.expandtab = true
    vim.bo.shiftwidth = 2
    vim.bo.tabstop = 2
  end,
})

vim.api.nvim_create_autocmd("FileType", {
  pattern = "go",
  callback = function()
    vim.bo.expandtab = false
    vim.bo.shiftwidth = 4
    vim.bo.tabstop = 4
  end,
})

-- Build artifacts and vendored trees are noise in file pickers and greps.
-- wildignore is a global option, so this is vim.opt rather than vim.opt_local.
vim.opt.wildignore:append({
  "*/node_modules/*",
  "*/.go/*",
  "*/.direnv/*",
  "*/bin/*",
  "*/dist/*",
  "*/site/*",
  "*/internal/server/static/*",
  "*/internal/server/docs_site/*",
})
