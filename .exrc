" Decision Theatre - Vim/Neovim Project Configuration
" ===================================================
" Project-specific settings and keybindings
" Note: For full which-key integration, see .nvim.lua

" Enable project-local config
set exrc
set secure

" Go settings
autocmd FileType go setlocal tabstop=4 shiftwidth=4 noexpandtab

" TypeScript/JavaScript settings
autocmd FileType typescript,typescriptreact,javascript,javascriptreact setlocal tabstop=2 shiftwidth=2 expandtab

" Project keybindings (legacy vim - use .nvim.lua for which-key)
" All under <leader>p prefix

" Build
nnoremap <leader>pba :!make app<CR>
nnoremap <leader>pbb :!make build-backend<CR>
nnoremap <leader>pbf :!make build-frontend<CR>
nnoremap <leader>pbc :!make clean<CR>

" Dev
nnoremap <leader>pda :terminal make dev-all<CR>
nnoremap <leader>pdb :terminal make dev-backend<CR>
nnoremap <leader>pdf :terminal make dev-frontend<CR>
nnoremap <leader>pdr :terminal nix run<CR>

" Test
nnoremap <leader>ptg :terminal make test<CR>
nnoremap <leader>ptf :terminal make test-frontend<CR>
nnoremap <leader>pta :terminal make test-all<CR>

" Quality
nnoremap <leader>pqf :!make fmt<CR>
nnoremap <leader>pql :terminal make lint<CR>
nnoremap <leader>pqc :terminal make check<CR>

" Docs
nnoremap <leader>pob :!make docs<CR>
nnoremap <leader>pos :terminal make docs-serve<CR>

" Packaging
nnoremap <leader>pka :terminal make packages<CR>
nnoremap <leader>pkl :terminal make packages-linux<CR>

" Data
nnoremap <leader>pxg :terminal make geopackage<CR>
nnoremap <leader>pxp :terminal make datapack<CR>

" Git
nnoremap <leader>pgs :!git status<CR>
nnoremap <leader>pgd :!git diff<CR>
nnoremap <leader>pgl :!git log --oneline -20<CR>

" Info
nnoremap <leader>pi :!make info<CR>
nnoremap <leader>ph :!make help<CR>
