" Decision Theatre — project-local vim configuration.
"
" This is the vimscript fallback for editors that do not load .nvim.lua.
" Neovim users get the richer version (which-key group labels, filetype
" indentation) from .nvim.lua automatically; both need `set exrc` in your own
" config, and neovim will ask you to `:trust` the file once.
"
" Every mapping below shells out to the Makefile, which calls
" scripts/run-app.sh for anything that launches the application, so neovim,
" `make run` and `nix run` all share one single source of truth.

" Neovim executes .nvim.lua, .nvimrc AND .exrc, so bail out here rather than
" defining every mapping twice. .nvim.lua is the neovim implementation.
if has('nvim')
  finish
endif

" Run — the canonical way to launch the app, in either mode
nnoremap <leader>pr :terminal make run<CR>
nnoremap <leader>ps :terminal make serve<CR>
nnoremap <leader>pR :terminal make run DT_FORCE_BUILD=1<CR>
nnoremap <leader>pn :terminal nix run<CR>

" Build
nnoremap <leader>pb :terminal make app<CR>
nnoremap <leader>pc :terminal make clean<CR>

" Hot-reload development
nnoremap <leader>ph :terminal make dev-all<CR>

" Health
nnoremap <leader>p? :terminal make doctor<CR>
nnoremap <leader>pF :terminal make check-flake<CR>
nnoremap <leader>pS :terminal make sync-flake<CR>
nnoremap <leader>pH :terminal dt<CR>

" Quality
nnoremap <leader>pt :terminal make test-all<CR>
nnoremap <leader>pl :terminal make lint<CR>
nnoremap <leader>pm :terminal make bench<CR>
nnoremap <leader>pM :terminal make bench-report<CR>
nnoremap <leader>pf :terminal make fmt<CR>
nnoremap <leader>pg :terminal make fmt-check<CR>
nnoremap <leader>pV :terminal make vet<CR>
nnoremap <leader>pC :terminal make check-shell<CR>
nnoremap <leader>pN :terminal make check-nix<CR>
nnoremap <leader>pG :terminal make check-secrets<CR>
nnoremap <leader>pD :terminal make check-drift<CR>
nnoremap <leader>pk :terminal make check<CR>

" Docs and data
nnoremap <leader>pd :terminal make docs-serve<CR>
nnoremap <leader>pv :terminal make check-data<CR>
nnoremap <leader>pp :terminal make pack-data<CR>

" Project conventions: Go uses tabs, everything else two spaces.
autocmd FileType typescript,typescriptreact,javascript,json,yaml,nix,lua
      \ setlocal expandtab shiftwidth=2 tabstop=2
autocmd FileType go setlocal noexpandtab shiftwidth=4 tabstop=4

" Build artifacts and vendored trees are noise in file pickers and greps.
set wildignore+=*/node_modules/*,*/.go/*,*/.direnv/*,*/bin/*,*/dist/*
set wildignore+=*/site/*,*/internal/server/static/*,*/internal/server/docs_site/*
