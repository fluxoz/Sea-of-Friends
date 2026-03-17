{
  description = "Sea of Friends — serverless P2P browser game using BitTorrent DHT + WebRTC";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = nixpkgs.legacyPackages.${system};

        # Sea of Friends static build artifact produced by `vite build`.
        sea-of-friends = pkgs.buildNpmPackage {
          pname = "sea-of-friends";
          version = "1.0.0";

          src = ./.;

          # To obtain the correct hash, run `nix build` once.
          # The build will fail and print a line like:
          #   got:    sha256-<hash>
          # Replace the placeholder value below with that hash.
          npmDepsHash = "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

          # The build script produces output in dist/
          buildPhase = ''
            runHook preBuild
            npm run build
            runHook postBuild
          '';

          installPhase = ''
            runHook preInstall
            mkdir -p $out
            cp -r dist/. $out/
            runHook postInstall
          '';
        };

        # Tiny wrapper that serves the built static files with vite preview.
        previewScript = pkgs.writeShellApplication {
          name = "sea-of-friends-preview";
          runtimeInputs = [ pkgs.nodejs ];
          text = ''
            exec npx vite preview --outDir "${sea-of-friends}" "$@"
          '';
        };

        # Wrapper that runs the Vite dev server (requires a checkout with
        # node_modules already installed via `npm install`).
        devScript = pkgs.writeShellApplication {
          name = "sea-of-friends-dev";
          runtimeInputs = [ pkgs.nodejs ];
          text = ''
            if [ ! -d node_modules ]; then
              echo "node_modules not found — running 'npm install' first…"
              npm install
            fi
            exec npx vite "$@"
          '';
        };

      in {
        # ── Packages ──────────────────────────────────────────────────────────
        packages = {
          default = sea-of-friends;
          sea-of-friends = sea-of-friends;
        };

        # ── Runnable apps ─────────────────────────────────────────────────────
        apps = {
          # `nix run` — serve the production build locally (vite preview)
          default = {
            type = "app";
            program = "${previewScript}/bin/sea-of-friends-preview";
          };

          # `nix run .#dev` — start the Vite dev server
          dev = {
            type = "app";
            program = "${devScript}/bin/sea-of-friends-dev";
          };
        };

        # ── Development shell ─────────────────────────────────────────────────
        devShells.default = pkgs.mkShell {
          buildInputs = [
            pkgs.nodejs   # includes npm
          ];

          shellHook = ''
            echo ""
            echo "  🌊 Sea of Friends — development shell"
            echo ""
            echo "  Commands:"
            echo "    npm install      — install dependencies"
            echo "    npm run dev      — start the Vite dev server (http://localhost:3000)"
            echo "    npm run build    — production build  →  dist/"
            echo "    npm run preview  — preview the production build"
            echo ""
          '';
        };
      }
    );
}
