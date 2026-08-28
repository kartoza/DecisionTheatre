{
  description = "Decision Theatre - Offline catchment data exploration";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs =
    { self
    , nixpkgs
    , flake-utils
    ,
    }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
        version = "2.6.0";

        # MkDocs environment for requirements documentation
        mkdocsEnv = pkgs.python3.withPackages (
          ps: with ps; [
            mkdocs
            mkdocs-material
            mkdocs-minify-plugin
            # Lets the documentation call into scripts/ for content rather than
            # restating it; see docs/hooks/macros.py.
            mkdocs-macros
            pygments
            pymdown-extensions
          ]
        );

        # Python environment for data tooling (GeoPackage creation)
        dataToolsEnv = pkgs.python3.withPackages (
          ps: with ps; [
            pandas
            geopandas
            shapely
          ]
        );

        # webkit2gtk-4.0 compatibility alias.
        #
        # github.com/webview/webview_go hardcodes its cgo directive as
        #   #cgo linux ... pkg-config: gtk+-3.0 webkit2gtk-4.0
        # with no build tag to select 4.1. nixpkgs ships only the 4.1 ABI, so
        # pkg-config fails and the build dies at "No package 'webkit2gtk-4.0'".
        #
        # This installs the real 4.1 pkg-config file under the 4.0 name, so the
        # lookup succeeds while still linking libwebkit2gtk-4.1.so — the only
        # library that exists. The two ABIs are compatible for webview's use.
        #
        # Generated from the 4.1 package rather than committed, so it can never
        # carry a stale store path. A committed .webkit-compat/ shim used to do
        # this job; it is gitignored, orphaned and now points at a webkitgtk
        # version no longer in the store.
        webkitCompat = pkgs.runCommand "webkit2gtk-4.0-compat" { } ''
          mkdir -p $out/lib/pkgconfig
          src=""
          for d in ${pkgs.webkitgtk_4_1.dev} ${pkgs.webkitgtk_4_1}; do
            if [ -f "$d/lib/pkgconfig/webkit2gtk-4.1.pc" ]; then
              src="$d/lib/pkgconfig/webkit2gtk-4.1.pc"
              break
            fi
          done
          if [ -z "$src" ]; then
            echo "webkit2gtk-4.1.pc not found in the webkitgtk_4_1 outputs" >&2
            exit 1
          fi
          cp "$src" $out/lib/pkgconfig/webkit2gtk-4.0.pc
        '';

        # =====================================================
        # Documentation: built via MkDocs
        # =====================================================
        docs = pkgs.stdenvNoCC.mkDerivation {
          pname = "decision-theatre-docs";
          inherit version;
          # docs/hooks/generate_diagrams.py reads the Go sources, flake.nix and
          # frontend/package.json at build time to draw diagrams that track the
          # real code. Those inputs must therefore be in the docs source tree —
          # they are all small text files. The hook degrades gracefully if any
          # are absent, so a narrower filter would silently drop diagrams rather
          # than fail the build.
          src = pkgs.lib.cleanSourceWith {
            src = ./.;
            filter =
              path: type:
              let
                p = toString path;
                baseName = baseNameOf p;
              in
              baseName == "mkdocs.yml"
              || baseName == "flake.nix"
              || baseName == "main.go"
              || baseName == "go.mod"
              # docs/hooks/command_reference.py renders the command reference by
              # running scripts/shell-help.sh, so the docs cannot restate the
              # command list and fall behind it.
              || pkgs.lib.hasPrefix (toString ./scripts) p
              || pkgs.lib.hasPrefix (toString ./docs) p
              || pkgs.lib.hasPrefix (toString ./internal) p
              || pkgs.lib.hasPrefix (toString ./frontend) p
              || pkgs.lib.hasPrefix (toString ./.github) p;
          };
          nativeBuildInputs = [ mkdocsEnv ];
          buildPhase = ''
            mkdocs build --strict -d site
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

          # Pins the exact npm dependency tree. It is derived from
          # frontend/package-lock.json, so ANY change to that file — including
          # the version field — changes this hash. Recompute with:
          #   nix run nixpkgs#prefetch-npm-deps -- frontend/package-lock.json
          npmDepsHash = "sha256-qCI5cEbDnuC4o4TfHoqZdarFskRRedCWd+ho98c+Tmo=";

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
            filter =
              path: type:
              let
                baseName = baseNameOf (toString path);
              in
                !(
                  baseName == ".go"
                  || baseName == ".direnv"
                  || baseName == "result"
                  || baseName == "node_modules"
                  || baseName == ".idea"
                  || baseName == ".vscode"
                  || (type == "regular" && pkgs.lib.hasSuffix ".gguf" baseName)
                  || (type == "regular" && pkgs.lib.hasSuffix ".gob" baseName)
                  || (type == "regular" && pkgs.lib.hasSuffix ".mbtiles" baseName)
                  || (type == "regular" && pkgs.lib.hasSuffix ".gpkg" baseName)
                );
          };

          # Pins the vendored Go module set. Derived from go.mod and go.sum.
          # Recompute after changing either, by emptying it and reading the
          # reported value:
          #   nix build 2>&1 | grep 'got:'
          #
          # The previous value was stale — it did not match the current go.sum.
          # It went unnoticed because a fixed-output derivation is only refetched
          # when its output path changes, and the path embeds the version. The
          # 0.2.0 output was already in the store, so nothing revalidated it until
          # the bump to 0.3.0 forced a rebuild.
          vendorHash = "sha256-LjBgQc1+ZgCer2aSug9kxSwumsGlp/owVgrUATnqPo8=";

          # The local replace directive (./internal/webview_go) needs the
          # source present during the go-modules download phase.
          overrideModAttrs = _: {
            postConfigure = ''
              cp -r ${./internal/webview_go} internal/webview_go
              chmod -R u+w internal/webview_go
            '';
          };

          # Only build the main package — internal/webview_go is a
          # separate Go module (used via replace) not a subpackage.
          subPackages = [ "." ];

          nativeBuildInputs = with pkgs; [
            gcc
            pkg-config
            wrapGAppsHook3
            makeWrapper
          ];

          buildInputs =
            with pkgs;
            [
            ]
            ++ pkgs.lib.optionals pkgs.stdenv.isLinux [
              webkitgtk_4_1
              # Supplies webkit2gtk-4.0.pc; see webkitCompat above.
              webkitCompat
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

        # =====================================================
        # Container image, built from this flake
        #
        # The hand-maintained Dockerfile listed its runtime dependencies by hand
        # — and got them wrong: it installed WebKit 4.0 while the flake, CI and
        # the Debian packaging all target 4.1, and it omitted a mkdocs plugin
        # that mkdocs.yml requires, so no image could be built at all. Both
        # faults are the same fault: a second dependency list maintained apart
        # from the one that is actually tested.
        #
        # dockerTools takes the runtime closure of the binary this flake already
        # builds, so the image contains exactly what the application links
        # against and nothing states a version twice. The image cannot disagree
        # with `nix build` about its dependencies, because it is derived from it.
        #
        #   nix build .#container && docker load < result
        #
        # buildLayeredImage rather than buildImage: the store paths become
        # separate layers, so a rebuild that changes only the application
        # re-uploads only that layer rather than the whole webkit closure.
        # =====================================================
        container = pkgs.dockerTools.buildLayeredImage {
          name = "decision-theatre";
          tag = version;

          # cacert is a genuine runtime dependency, not boilerplate: the geocode
          # endpoint proxies to an upstream over TLS, and without a trust store
          # every place-name search fails at certificate verification.
          #
          # The Debian image also installed jq. Nothing in the running container
          # uses it — it is used by scripts/sync-flake.sh and scripts/doctor.sh,
          # which are developer tools — so it is not carried here.
          contents = [
            pkgs.cacert
            pkgs.tzdata
          ];

          # The application's own closure arrives through Entrypoint below;
          # listing it here as well would only duplicate it.
          config = {
            Entrypoint = [ "${decision-theatre}/bin/decision-theatre" ];

            # Identical to the Dockerfile's CMD, so `docker compose` keeps
            # working unchanged. --bind 0.0.0.0 is required and deliberate: the
            # process must accept connections from outside its own network
            # namespace to be reachable at all. The default is loopback because
            # the API is unauthenticated, so it is nginx in front of this
            # container that controls access.
            Cmd = [
              "--headless"
              "--bind"
              "0.0.0.0"
              "--port"
              "8080"
              "--data-dir"
              "/app/data"
              "--resources-dir"
              "/app/resources"
            ];

            WorkingDir = "/app";

            ExposedPorts = {
              "8080/tcp" = { };
              "8081/tcp" = { };
              "8082/tcp" = { };
              "8083/tcp" = { };
            };

            Env = [
              # Go's TLS stack finds a trust store at one of a handful of fixed
              # paths, none of which a nix image has; naming it is what makes
              # cacert above take effect.
              "SSL_CERT_FILE=${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt"
              # Settings are saved under $HOME, and the compose file mounts a
              # volume at /root/.config/decision-theatre expecting exactly this.
              "HOME=/root"
              "TZ=UTC"
            ];
          };

          # The two directories the compose file mounts over, so the image is
          # usable without them too. Kept to mkdir alone — anything longer
          # belongs in a script under scripts/ rather than inside a nix string.
          extraCommands = ''
            mkdir -p app/data app/resources root/.config
          '';
        };

        # Launcher for `nix run`. The launch policy (desktop WebView mode,
        # flags, data directory resolution) lives in scripts/run-app.sh so that
        # `nix run`, `make run` and the neovim <leader>pr mapping cannot drift
        # apart. DT_BIN points the script at the reproducible store binary, so
        # it skips every build step and only applies that shared policy.
        # mode is "desktop" or "server"; both wrap the same script and the same
        # store binary, so the only difference is which window, if any, opens.
        mkLauncher =
          mode:
          pkgs.stdenvNoCC.mkDerivation {
            pname = "decision-theatre-${mode}";
            inherit version;
            # The whole scripts directory, not just run-app.sh: the launcher
            # sources lib-build.sh from alongside itself, and installing the one
            # file would leave a launcher that dies on its first source.
            src = ./scripts;
            nativeBuildInputs = [ pkgs.makeWrapper ];
            installPhase = ''
              runHook preInstall

              mkdir -p $out/libexec/decision-theatre
              install -m755 run-app.sh lib-build.sh $out/libexec/decision-theatre/

              makeWrapper $out/libexec/decision-theatre/run-app.sh \
                $out/bin/decision-theatre-${mode} \
                --set DT_BIN ${decision-theatre}/bin/decision-theatre \
                --set-default DT_MODE ${mode} \
                --prefix PATH : ${
                  pkgs.lib.makeBinPath [
                    pkgs.bash
                    pkgs.coreutils
                  ]
                }
              runHook postInstall
            '';
            meta = with pkgs.lib; {
              description =
                if mode == "server" then
                  "Run Decision Theatre as a web server"
                else
                  "Launch the Decision Theatre desktop application";
              license = licenses.gpl3;
              mainProgram = "decision-theatre-${mode}";
            };
          };

        run-app = mkLauncher "desktop";
        serve-app = mkLauncher "server";

        # Data tools. The checks and the packer live in Go, in
        # internal/datacheck, and reach the data through the same loaders the
        # application uses — so they cannot describe a different data directory
        # from the one the app actually reads. These derivations only put the
        # right subcommand on the PATH under its own name.
        #
        # subcommand is "check-data" or "pack-data".
        mkDataTool =
          subcommand:
          pkgs.writeShellApplication {
            name = subcommand;
            runtimeInputs = [ decision-theatre ];
            text = ''
              exec decision-theatre ${subcommand} "$@"
            '';
          };

        check-data = mkDataTool "check-data";
        pack-data = mkDataTool "pack-data";

        # Developer-workflow scripts exposed as nix apps, so they can be run on
        # a machine that has not entered the development shell — which is what
        # CI does. Each wraps the tracked script rather than restating it.
        mkScriptTool =
          { name
          , script
          , runtimeInputs ? [ ]
          ,
          }:
          pkgs.writeShellApplication {
            inherit name runtimeInputs;
            # The scripts source their siblings from scripts/, so they run from
            # the checkout rather than a store copy. That is deliberate: a copy
            # in the store would go stale against the tree being checked.
            text = ''
              if [ ! -x "./scripts/${script}" ]; then
                echo "${name}: run this from the project root (./scripts/${script} not found)" >&2
                exit 2
              fi
              exec "./scripts/${script}" "$@"
            '';
          };

        doctor = mkScriptTool {
          name = "doctor";
          script = "doctor.sh";
          runtimeInputs = with pkgs; [
            jq
            git
            gnugrep
            gnused
            findutils
            coreutils
          ];
        };

        check-flake = mkScriptTool {
          name = "check-flake";
          script = "sync-flake.sh";
          runtimeInputs = with pkgs; [
            jq
            gnugrep
            gnused
            coreutils
          ];
        };

      in
      {
        # =====================================================
        # Packages
        # =====================================================
        packages = {
          inherit
            frontend
            docs
            decision-theatre
            run-app
            serve-app
            check-data
            pack-data
            doctor
            check-flake
            container
            ;
          default = decision-theatre;
        };

        # =====================================================
        # Checks: run tests in a nix build
        # =====================================================
        checks = {
          go-tests = pkgs.stdenvNoCC.mkDerivation {
            name = "decision-theatre-go-tests";
            src = ./.;
            nativeBuildInputs = with pkgs; [
              go
              gcc
              pkg-config
            ];
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
            # Same source as the frontend package, so the same hash.
            npmDepsHash = "sha256-qCI5cEbDnuC4o4TfHoqZdarFskRRedCWd+ho98c+Tmo=";
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
        # Tooling shell: nix develop .#tooling
        #
        # The checks themselves, without the build toolchain. CI and the
        # pre-commit hooks use this, so what runs in review is what runs on a
        # contributor's machine — and a contributor who only wants to run the
        # checks does not pay for Go, Node and GDAL to be realised first.
        # =====================================================
        devShells.tooling = pkgs.mkShell {
          buildInputs = with pkgs; [
            pre-commit
            shellcheck
            shfmt
            gitleaks
            reuse
            statix
            nixpkgs-fmt
            jq
            git
          ];
        };

        # =====================================================
        # Supply-chain shell: nix develop .#supplychain
        #
        # syft and grype for the SBOM and vulnerability scan, and the python3
        # that renders them into the report tables.
        #
        # These used to be fetched in CI with `curl … | sh -s -- -b /usr/local/bin`
        # from anchore's install scripts. That is the one thing a supply-chain
        # step must not do: it pipes a remote script into a shell to obtain the
        # tools that are supposed to be telling us what we are shipping, at
        # whatever version main happened to be that morning. Nothing pinned it,
        # nothing verified it, and the answer could differ between two runs of
        # the same commit.
        #
        # From nixpkgs they are pinned by flake.lock, so a scan is reproducible
        # and a version change is a reviewable diff. Kept out of .#tooling
        # deliberately: a contributor running the pre-commit checks should not
        # have to realise a vulnerability scanner first.
        # =====================================================
        devShells.supplychain = pkgs.mkShell {
          buildInputs = with pkgs; [
            syft
            grype
            python3
          ];
        };

        # =====================================================
        # Dev shell: nix develop
        # All tools available, no internet needed after first eval
        # =====================================================
        devShells.default = pkgs.mkShell {
          buildInputs =
            with pkgs;
            [
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

              # Data tooling (GeoPackage creation)
              dataToolsEnv

              # Nix tooling
              nil
              nixpkgs-fmt

              # Terminal UI for the command table and the report scripts
              gum

              # VCS
              git
              gh

              # Packaging
              nfpm
              zip

              # Security scanning
              trivy
            ]
            ++ pkgs.lib.optionals pkgs.stdenv.isLinux [
              # WebView (embedded browser window)
              webkitgtk_4_1
              # Supplies webkit2gtk-4.0.pc; see webkitCompat above.
              webkitCompat
              gtk3

              # Windows cross-compilation
              pkgs.pkgsCross.mingwW64.stdenv.cc
            ];

          # The whole environment — Go paths, shortcuts, the `dt` command table —
          # lives in scripts/dev-shell.sh rather than here, so it is ordinary
          # reviewable shell rather than a string inside nix. This hook only
          # locates and sources it.
          shellHook = ''
            export DT_PROJECT_ROOT="$PWD"

            # A locale archive that actually contains the locale LANG names.
            # NixOS systems frequently set LANG to a locale the system archive
            # was never built with, and glibc then falls back to "C" — which is
            # how the desktop window came to lay itself out a million times too
            # large. See locale.go for the mechanism.
            ${pkgs.lib.optionalString pkgs.stdenv.isLinux ''
              export LOCALE_ARCHIVE="${pkgs.glibcLocales}/lib/locale/locale-archive"
            ''}
            if [ -r "$DT_PROJECT_ROOT/scripts/dev-shell.sh" ]; then
              # shellcheck source=scripts/dev-shell.sh
              . "$DT_PROJECT_ROOT/scripts/dev-shell.sh"
            else
              echo "warning: scripts/dev-shell.sh not found under $DT_PROJECT_ROOT;" >&2
              echo "         enter the shell from the project root for the usual setup." >&2
            fi
          '';
        };

        # =====================================================
        # Apps: nix run
        # =====================================================
        # Wraps scripts/run-app.sh rather than invoking the binary directly, so
        # `nix run`, `make run` and neovim all launch the app the same way.
        # The binary itself is still the pure, reproducible store build.
        apps.default = {
          type = "app";
          program = "${run-app}/bin/decision-theatre-desktop";
        };

        # nix run .#serve — the same application without the desktop window,
        # for a browser to connect to.
        apps.serve = {
          type = "app";
          program = "${serve-app}/bin/decision-theatre-server";
        };

        # nix run .#check-data -- [DATA_DIR]
        #
        # Runs the application's own check-data subcommand, so nix, make and a
        # plain shell all execute identical logic — the logic the app itself
        # uses to read the directory.
        apps.check-data = {
          type = "app";
          program = "${check-data}/bin/check-data";
        };

        # nix run .#pack-data -- [DATA_DIR]
        apps.pack-data = {
          type = "app";
          program = "${pack-data}/bin/pack-data";
        };

        # Deprecated name for check-data, kept so existing deployment gates and
        # documentation keep working.
        apps.validate-data = {
          type = "app";
          program = "${check-data}/bin/check-data";
        };

        # nix run .#doctor — is this checkout healthy?
        apps.doctor = {
          type = "app";
          program = "${doctor}/bin/doctor";
        };

        # nix run .#check-flake -- [--check|--verify]
        #
        # The lock-step gate. CI runs this before anything else: a flake whose
        # hashes have fallen behind its manifests fails for every importer, so
        # it is worth failing fast and saying exactly that.
        apps.check-flake = {
          type = "app";
          program = "${check-flake}/bin/check-flake";
        };
      }
    );
}
