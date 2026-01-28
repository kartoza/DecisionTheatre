{
  description = "Decision Theatre - Offline catchment data exploration with embedded AI";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
        version = "0.1.0";

        # MkDocs environment for requirements documentation
        mkdocsEnv = pkgs.python3.withPackages (ps: with ps; [
          mkdocs
          mkdocs-material
          mkdocs-minify-plugin
          pygments
          pymdown-extensions
        ]);

        # =====================================================
        # Frontend: built via buildNpmPackage
        # All npm dependencies are fetched into the nix store
        # with a pinned hash. No npm at runtime. Full SBOM.
        # =====================================================
        frontend = pkgs.buildNpmPackage {
          pname = "decision-theatre-frontend";
          inherit version;
          src = ./frontend;

          # This hash pins the exact npm dependency tree.
          # After first build attempt, nix will tell you the
          # correct hash. Set to empty string to get it:
          #   nix build .#frontend 2>&1 | grep 'got:'
          # Then paste the sha256 here.
          npmDepsHash = "sha256-ke3NJYwS/7BTxwFXLCVElDVXJY0hcGrjWIgQ905YJxk=";

          # The build script (tsc && vite build) outputs to dist/
          buildPhase = ''
            npm run build
          '';

          installPhase = ''
            mkdir -p $out
            cp -r dist/* $out/
          '';
        };

        # =====================================================
        # Backend: Go binary with embedded frontend assets
        # The frontend derivation output is copied into
        # internal/server/static/ before go build runs.
        # =====================================================
        decision-theatre = pkgs.buildGoModule {
          pname = "decision-theatre";
          inherit version;
          src = pkgs.lib.cleanSourceWith {
            src = ./.;
            filter = path: type:
              let baseName = baseNameOf (toString path); in
              ! (
                baseName == ".go" ||
                baseName == ".direnv" ||
                baseName == "result" ||
                baseName == "node_modules" ||
                baseName == ".idea" ||
                baseName == ".vscode" ||
                (type == "regular" && pkgs.lib.hasSuffix ".gguf" baseName) ||
                (type == "regular" && pkgs.lib.hasSuffix ".gob" baseName) ||
                (type == "regular" && pkgs.lib.hasSuffix ".mbtiles" baseName) ||
                (type == "regular" && pkgs.lib.hasSuffix ".parquet" baseName) ||
                (type == "regular" && pkgs.lib.hasSuffix ".geoparquet" baseName)
              );
          };

          # After first build: nix will report the correct hash.
          # Set to empty string to get it, then pin.
          vendorHash = "sha256-C/dEL6GJn9so3luR3C00l3BKITV/M1qiseflW7iPaKs=";

          nativeBuildInputs = with pkgs; [
            gcc
            pkg-config
            wrapGAppsHook3
          ];

          buildInputs = with pkgs; [
            openblas
          ] ++ pkgs.lib.optionals pkgs.stdenv.isLinux [
            webkitgtk_4_1
            gtk3
            glib-networking
            gsettings-desktop-schemas
          ];

          ldflags = [
            "-s"
            "-w"
            "-X main.version=${version}"
          ];

          # Inject the nix-built frontend into the embed directory
          preBuild = ''
            export CGO_ENABLED=1
            rm -rf internal/server/static
            mkdir -p internal/server/static
            cp -r ${frontend}/* internal/server/static/

            # webview_go hardcodes webkit2gtk-4.0 but nixpkgs ships 4.1
            # Create compat pkg-config and library symlink
            mkdir -p $TMPDIR/pkgconfig $TMPDIR/lib
            sed 's/webkit2gtk-4.1/webkit2gtk-4.0/g; s/Name: webkit2gtk-4.1/Name: webkit2gtk-4.0/' \
              ${pkgs.webkitgtk_4_1.dev}/lib/pkgconfig/webkit2gtk-4.1.pc \
              > $TMPDIR/pkgconfig/webkit2gtk-4.0.pc
            # Fix lib path in the .pc to point to our compat dir
            sed -i "s|-lwebkit2gtk-4.1|-lwebkit2gtk-4.0|g" $TMPDIR/pkgconfig/webkit2gtk-4.0.pc
            ln -sf ${pkgs.webkitgtk_4_1}/lib/libwebkit2gtk-4.1.so $TMPDIR/lib/libwebkit2gtk-4.0.so
            export PKG_CONFIG_PATH="$TMPDIR/pkgconfig:$PKG_CONFIG_PATH"
            export CGO_LDFLAGS="-L$TMPDIR/lib $CGO_LDFLAGS"
          '';

          postInstall = pkgs.lib.optionalString pkgs.stdenv.isLinux ''
            mkdir -p $out/share/applications
            cat > $out/share/applications/decision-theatre.desktop << 'DESKTOP'
            [Desktop Entry]
            Name=Decision Theatre
            Comment=Offline catchment data exploration with embedded AI
            Exec=decision-theatre
            Icon=map
            Terminal=false
            Type=Application
            Categories=Science;Geography;Education;
            Keywords=catchment;africa;scenario;map;ai;
            DESKTOP
          '';

          meta = with pkgs.lib; {
            description = "Offline catchment data exploration with embedded AI";
            homepage = "https://github.com/kartoza/decision-theatre";
            license = licenses.gpl3;
            maintainers = [ ];
          };
        };

      in
      {
        # =====================================================
        # Packages
        # =====================================================
        packages = {
          inherit frontend decision-theatre;
          default = decision-theatre;
        };

        # =====================================================
        # Checks: run tests in a nix build
        # =====================================================
        checks = {
          go-tests = pkgs.stdenvNoCC.mkDerivation {
            name = "decision-theatre-go-tests";
            src = ./.;
            nativeBuildInputs = with pkgs; [ go gcc pkg-config openblas ];
            buildPhase = ''
              export HOME=$TMPDIR
              export GOPATH=$TMPDIR/go
              export GOCACHE=$TMPDIR/go-cache

              # Inject frontend so embed doesn't fail
              rm -rf internal/server/static
              mkdir -p internal/server/static
              cp -r ${frontend}/* internal/server/static/

              go test -race -coverprofile=coverage.out ./...
            '';
            installPhase = ''
              mkdir -p $out
              cp coverage.out $out/ 2>/dev/null || true
              echo "tests passed" > $out/result
            '';
          };

          frontend-tests = pkgs.buildNpmPackage {
            pname = "decision-theatre-frontend-tests";
            inherit version;
            src = ./frontend;
            npmDepsHash = "";
            buildPhase = ''
              npm test
            '';
            installPhase = ''
              mkdir -p $out
              echo "tests passed" > $out/result
            '';
          };
        };

        # =====================================================
        # Dev shell: nix develop
        # All tools available, no internet needed after first eval
        # =====================================================
        devShells.default = pkgs.mkShell {
          buildInputs = with pkgs; [
            # Go toolchain
            go
            gopls
            golangci-lint
            gomodifytags
            gotests
            impl
            delve
            go-tools

            # Node.js (for frontend dev iteration only)
            nodejs_22

            # CGO + llama.cpp build tools
            gnumake
            gcc
            clang
            cmake
            pkg-config

            # llama.cpp / linear algebra
            openblas

            # CLI utilities
            ripgrep
            fd
            eza
            bat
            fzf
            tree
            jq
            yq

            # Geospatial tools
            tippecanoe
            sqlite
            gdal

            # Documentation
            mkdocsEnv

            # Nix tooling
            nil
            nixpkgs-fmt
            nixfmt-rfc-style

            # VCS
            git
            gh

            # Security scanning
            trivy
          ] ++ pkgs.lib.optionals pkgs.stdenv.isLinux [
            # WebView (embedded browser window)
            webkitgtk_4_1
            gtk3
          ];

          shellHook = ''
            export EDITOR=nvim
            export GOPATH="$PWD/.go"
            export GOCACHE="$PWD/.go/cache"
            export GOMODCACHE="$PWD/.go/pkg/mod"
            export PATH="$GOPATH/bin:$PATH"

            # CGO flags for openblas (llama.cpp dependency)
            export CGO_ENABLED=1
            export CGO_CFLAGS="-I${pkgs.openblas}/include"
            export CGO_LDFLAGS="-L${pkgs.openblas}/lib -lopenblas"

            alias ll='eza -la'
            alias la='eza -a'
            alias ls='eza'
            alias cat='bat --plain'

            alias gor='go run .'
            alias got='go test -v ./...'
            alias gob='make build-backend'
            alias gom='go mod tidy'
            alias gol='golangci-lint run'

            alias gs='git status'
            alias ga='git add'
            alias gc='git commit'
            alias gl='git log --oneline -10'
            alias gd='git diff'

            echo ""
            echo "Decision Theatre Development Environment"
            echo ""
            echo "Nix commands:"
            echo "  nix build             - Build the full application"
            echo "  nix build .#frontend  - Build only the frontend"
            echo "  nix flake check       - Run all tests"
            echo "  nix run               - Build and run the application"
            echo ""
            echo "Dev iteration (uses tools from nix store):"
            echo "  make dev              - Run Go backend (port 8080)"
            echo "  make dev-frontend     - Run Vite dev server"
            echo "  make test             - Run Go tests"
            echo "  make test-frontend    - Run frontend tests"
            echo "  make docs-serve       - Serve requirements docs"
            echo ""
          '';
        };

        # =====================================================
        # Apps: nix run
        # =====================================================
        apps.default = {
          type = "app";
          program = "${decision-theatre}/bin/decision-theatre";
        };
      }
    );
}
