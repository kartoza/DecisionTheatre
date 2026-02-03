{
  description = "Decision Theatre - Offline catchment data exploration";

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

        # Python environment for data tooling (CSV -> Parquet conversion)
        dataToolsEnv = pkgs.python3.withPackages (ps: with ps; [
          pyarrow
        ]);

        # =====================================================
        # Documentation: built via MkDocs
        # =====================================================
        docs = pkgs.stdenvNoCC.mkDerivation {
          pname = "decision-theatre-docs";
          inherit version;
          src = pkgs.lib.cleanSourceWith {
            src = ./.;
            filter = path: type:
              let baseName = baseNameOf (toString path); in
              baseName == "mkdocs.yml" ||
              pkgs.lib.hasPrefix (toString ./docs) (toString path);
          };
          nativeBuildInputs = [ mkdocsEnv ];
          buildPhase = ''
            mkdocs build -d site
          '';
          installPhase = ''
            mkdir -p $out
            cp -r site/* $out/
          '';
        };

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

          # Using vendored dependencies from ./vendor directory
          vendorHash = null;

          nativeBuildInputs = with pkgs; [
            gcc
            pkg-config
            wrapGAppsHook3
            makeWrapper
          ];

          buildInputs = with pkgs; [
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
            rm -rf internal/server/static internal/server/docs_site
            mkdir -p internal/server/static internal/server/docs_site
            cp -r ${frontend}/* internal/server/static/
            cp -r ${docs}/* internal/server/docs_site/

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
            Comment=Offline catchment data exploration
            Exec=decision-theatre
            Icon=map
            Terminal=false
            Type=Application
            Categories=Science;Geography;Education;
            Keywords=catchment;africa;scenario;map;
            DESKTOP
          '';

          meta = with pkgs.lib; {
            description = "Offline catchment data exploration";
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
          inherit frontend docs decision-theatre;
          default = decision-theatre;
        };

        # =====================================================
        # Checks: run tests in a nix build
        # =====================================================
        checks = {
          go-tests = pkgs.stdenvNoCC.mkDerivation {
            name = "decision-theatre-go-tests";
            src = ./.;
            nativeBuildInputs = with pkgs; [ go gcc pkg-config ];
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
            air

            # Node.js (for frontend dev iteration only)
            nodejs_22

            # CGO build tools
            gnumake
            gcc
            pkg-config

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

            # Data tooling (CSV -> Parquet)
            dataToolsEnv

            # Nix tooling
            nil
            nixpkgs-fmt
            nixfmt-rfc-style

            # VCS
            git
            gh

            # Packaging
            nfpm
            zip

            # Security scanning
            trivy
          ] ++ pkgs.lib.optionals pkgs.stdenv.isLinux [
            # WebView (embedded browser window)
            webkitgtk_4_1
            gtk3

            # Windows cross-compilation
            pkgs.pkgsCross.mingwW64.stdenv.cc
          ];

          shellHook = ''
            export EDITOR=nvim
            export GOPATH="$PWD/.go"
            export GOCACHE="$PWD/.go/cache"
            export GOMODCACHE="$PWD/.go/pkg/mod"
            export PATH="$GOPATH/bin:$PATH"

            export CGO_ENABLED=1

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
            echo "  make dev-all          - Go hot-reload + Vite HMR (recommended)"
            echo "  make dev-backend      - Go backend with air (hot-reload on :8080)"
            echo "  make dev-frontend     - Vite dev server (HMR on :5173)"
            echo "  make dev              - Run Go backend once (no hot-reload)"
            echo "  make test             - Run Go tests"
            echo "  make test-frontend    - Run frontend tests"
            echo "  make docs-serve       - Serve requirements docs"
            echo ""
            echo "Data & packaging:"
            echo "  make csv2parquet      - Convert CSV data files to Parquet"
            echo "  make datapack         - Build data pack zip (parquet + mbtiles)"
            echo "  make list-datapack    - List contents of last built data pack"
            echo "  make packages         - Build release packages (all platforms)"
            echo "  make packages-linux   - Linux .tar.gz, .deb, .rpm"
            echo "  make packages-windows - Windows .zip, .msi"
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
