{
  description = "mc-save: official Minecraft Java save codecs and strict versioned persistence for the nerima-games Minecraft-clone rebuild.";

  inputs = {
    # nixos-unstable, not nixpkgs-unstable: it advances only after the NixOS
    # release tests pass, so it is less likely to land a broken build.
    #
    # flake.lock is pinned to revision 624af665 rather than the channel head:
    # newer nixos-unstable revisions ship oxlint >=1.79.0, whose
    # `no-redeclare` rule misfires on the `type X … & Brand` +
    # `const X = Brand.refined` idiom used across this org (0 warnings on
    # 1.75.0, 59 on 1.79.0 measured against an identical tree). Re-check this
    # pin the next time the org bumps nixpkgs.
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
      # Keep Nix formatting available to both supported systems. This makes
      # `nix fmt -- --check flake.nix` part of the repository's own flake
      # contract. The explicit file argument makes the check work with
      # nixfmt's file-oriented CLI as well as editor integrations.
      formatter = forAllSystems (system: (pkgsFor system).nixfmt);

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
          # oxlint is intentionally supplied by Nix rather than package.json.
          # This keeps the executable version in the reproducible development
          # shell and avoids a second package-manager lockfile entry.
          #
          # ast-grep is here for the same reason, and covers what oxlint cannot:
          # it implements none of no-restricted-syntax, no-restricted-properties
          # or no-restricted-globals, so the org-wide ban on reading a
          # process-global clock had no mechanical gate. `.ast-grep/rules/`
          # holds that gate. Structural matching is the point — the ban is
          # documented in prose beside the code it governs, and a textual check
          # would fail its own documentation.
          default = pkgs.mkShell {
            packages = [
              pkgs.nodejs_24
              pkgs.corepack_24
              pkgs.typescript-language-server
              pkgs.oxlint
              pkgs.ast-grep
            ];

            shellHook = ''
              corepackDir="$(mktemp -d "''${TMPDIR:-/tmp}/mc-save-corepack.XXXXXX")"
              corepack enable --install-directory "$corepackDir"
              export PATH="$corepackDir:$PATH"
            '';
          };
        }
      );
    };
}
