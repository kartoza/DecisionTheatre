-- Decision Theatre - Neovim Project Configuration
-- ================================================
-- Project-specific keybindings under <leader>p
-- All commands run inside nix develop environment

local ok, wk = pcall(require, "which-key")
if not ok then
  vim.notify("which-key not found, skipping project keybindings", vim.log.levels.WARN)
  return
end

-- Helper to run commands in a terminal
local function term_cmd(cmd, title)
  return function()
    vim.cmd("vsplit | terminal " .. cmd)
    vim.cmd("startinsert")
    if title then
      vim.api.nvim_buf_set_name(0, title)
    end
  end
end

-- Helper to run commands silently and notify
local function silent_cmd(cmd)
  return function()
    vim.fn.jobstart(cmd, {
      on_exit = function(_, code)
        if code == 0 then
          vim.notify("Command completed: " .. cmd, vim.log.levels.INFO)
        else
          vim.notify("Command failed: " .. cmd, vim.log.levels.ERROR)
        end
      end,
    })
  end
end

wk.add({
  { "<leader>p", group = "Project (Decision Theatre)" },

  -- Build commands
  { "<leader>pb", group = "Build" },
  { "<leader>pba", term_cmd("make app", "Build App"), desc = "Build full app (nix)" },
  { "<leader>pbb", term_cmd("make build-backend", "Build Backend"), desc = "Build backend only" },
  { "<leader>pbf", term_cmd("make build-frontend", "Build Frontend"), desc = "Build frontend only" },
  { "<leader>pbd", term_cmd("make build-docs", "Build Docs"), desc = "Build docs (embed)" },
  { "<leader>pbc", term_cmd("make clean", "Clean"), desc = "Clean build artifacts" },

  -- Development commands
  { "<leader>pd", group = "Dev" },
  { "<leader>pda", term_cmd("make dev-all", "Dev All"), desc = "Full dev stack (air + vite)" },
  { "<leader>pdb", term_cmd("make dev-backend", "Dev Backend"), desc = "Backend hot-reload (air)" },
  { "<leader>pdf", term_cmd("make dev-frontend", "Dev Frontend"), desc = "Frontend HMR (vite)" },
  { "<leader>pdr", term_cmd("nix run", "Nix Run"), desc = "Run via nix" },

  -- Testing commands
  { "<leader>pt", group = "Test" },
  { "<leader>ptg", term_cmd("make test", "Go Tests"), desc = "Go tests + coverage" },
  { "<leader>ptf", term_cmd("make test-frontend", "Frontend Tests"), desc = "Frontend tests (vitest)" },
  { "<leader>pta", term_cmd("make test-all", "All Tests"), desc = "All tests" },

  -- Code quality
  { "<leader>pq", group = "Quality" },
  { "<leader>pqf", term_cmd("make fmt", "Format"), desc = "Format code (go fmt)" },
  { "<leader>pql", term_cmd("make lint", "Lint"), desc = "Lint (golangci-lint)" },
  { "<leader>pqc", term_cmd("make check", "Check"), desc = "Full check (fmt + lint + test)" },
  { "<leader>pqt", silent_cmd("make deps"), desc = "Tidy dependencies (go mod tidy)" },

  -- Documentation
  { "<leader>po", group = "Docs" },
  { "<leader>pob", term_cmd("make docs", "Build Docs"), desc = "Build docs (mkdocs)" },
  { "<leader>pos", term_cmd("make docs-serve", "Serve Docs"), desc = "Serve docs (localhost:8000)" },
  { "<leader>por", term_cmd("make docs-requirements-serve", "Requirements Docs"), desc = "Serve requirements docs" },
  { "<leader>poo", silent_cmd("xdg-open http://localhost:8000"), desc = "Open docs in browser" },

  -- Packaging
  { "<leader>pk", group = "Package" },
  { "<leader>pka", term_cmd("make packages", "All Packages"), desc = "Build all packages" },
  { "<leader>pkl", term_cmd("make packages-linux", "Linux Packages"), desc = "Linux packages" },
  { "<leader>pkw", term_cmd("make packages-windows", "Windows Packages"), desc = "Windows packages" },
  { "<leader>pkd", term_cmd("make packages-darwin", "Darwin Packages"), desc = "macOS packages" },

  -- Data
  { "<leader>px", group = "Data" },
  { "<leader>pxg", term_cmd("make geopackage", "Build GeoPackage"), desc = "Build datapack.gpkg" },
  { "<leader>pxp", term_cmd("make datapack", "Package Data"), desc = "Package data (.zip)" },
  { "<leader>pxl", term_cmd("make list-datapack", "List Datapack"), desc = "List datapack contents" },

  -- Design system
  { "<leader>ps", group = "Design System" },
  { "<leader>pse", term_cmd("make design-export", "Design Export"), desc = "Export design tokens" },
  { "<leader>psi", term_cmd("make design-import", "Design Import"), desc = "Import design tokens" },
  { "<leader>psp", term_cmd("make design-preview", "Design Preview"), desc = "Preview design import" },

  -- Git/Release
  { "<leader>pg", group = "Git/Release" },
  { "<leader>pgr", term_cmd("./scripts/create-new-release.sh", "Release"), desc = "Create new release" },
  { "<leader>pgs", term_cmd("git status", "Git Status"), desc = "Git status" },
  { "<leader>pgd", term_cmd("git diff", "Git Diff"), desc = "Git diff" },
  { "<leader>pgl", term_cmd("git log --oneline -20", "Git Log"), desc = "Git log (last 20)" },

  -- Nix
  { "<leader>pn", group = "Nix" },
  { "<leader>pnb", term_cmd("nix build", "Nix Build"), desc = "Nix build" },
  { "<leader>pnf", term_cmd("nix build .#frontend", "Nix Frontend"), desc = "Nix build frontend" },
  { "<leader>pnc", term_cmd("nix flake check", "Nix Check"), desc = "Nix flake check" },
  { "<leader>pnu", term_cmd("nix flake update", "Nix Update"), desc = "Nix flake update" },

  -- Info/Help
  { "<leader>pi", term_cmd("make info", "Project Info"), desc = "Project info" },
  { "<leader>ph", term_cmd("make help", "Project Help"), desc = "Makefile help" },
})

-- LSP settings for Go
vim.api.nvim_create_autocmd("FileType", {
  pattern = "go",
  callback = function()
    vim.opt_local.tabstop = 4
    vim.opt_local.shiftwidth = 4
    vim.opt_local.expandtab = false
  end,
})

-- LSP settings for TypeScript/JavaScript (frontend)
vim.api.nvim_create_autocmd("FileType", {
  pattern = { "typescript", "typescriptreact", "javascript", "javascriptreact" },
  callback = function()
    vim.opt_local.tabstop = 2
    vim.opt_local.shiftwidth = 2
    vim.opt_local.expandtab = true
  end,
})

-- Auto-format Go files on save
vim.api.nvim_create_autocmd("BufWritePre", {
  pattern = "*.go",
  callback = function()
    vim.lsp.buf.format({ async = false })
  end,
})

vim.notify("Decision Theatre project config loaded. Use <leader>p for project commands.", vim.log.levels.INFO)
