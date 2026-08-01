{
  description = "mc-save: Persistence toolkit for the nerima-games Minecraft-clone rebuild: versioned save formats with migration chains, a format registry, and the StoragePort with an in-memory adapter.";

  inputs = {
    # nixos-unstable, not nixpkgs-unstable: it advances only after the NixOS
    # release tests pass, so it is less likely to land a broken build.
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs =
    { nixpkgs, ... }:
    let
      # Only what is actually exercised: x86_64-linux by CI, aarch64-darwin by
      # the maintainer. Declaring a platform nothing builds makes
      # `nix flake check --all-systems` fail rather than skip it.
      systems = [
        "x86_64-linux"
        "aarch64-darwin"
      ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
      pkgsFor = system: nixpkgs.legacyPackages.${system};
    in
    {
      devShells = forAllSystems (
        system:
        let
          pkgs = pkgsFor system;
        in
        {
          # Node 24 matches the `engines` field and the CI runner. pnpm comes
          # from corepack rather than nixpkgs so that the version is decided by
          # the `packageManager` field in package.json — one source of truth
          # instead of two that can drift.
          #
          # oxlint is the opposite case: it is NOT a package.json devDependency.
          # It used to be, and every repo in the org independently drifted onto
          # a different version (some on 0.12.x, some on 1.76.x) without anyone
          # noticing, because the config file (`.oxlintrc.json`) had a filename
          # bug that meant it was never actually being loaded either way — see
          # DEPENDENCY_POLICY.md §5's "前提条件" note. Once that bug was fixed,
          # a single pinned Nix-provided oxlint became the one source of truth
          # instead of 16 independently-drifting npm pins.
          default = pkgs.mkShell {
            packages = [
              pkgs.nodejs_24
              pkgs.corepack_24
              pkgs.typescript-language-server
              pkgs.oxlint
            ];

            shellHook = ''
              mkdir -p "$PWD/.corepack"
              corepack enable --install-directory "$PWD/.corepack"
              export PATH="$PWD/.corepack:$PATH"
            '';
          };
        }
      );
    };
}
