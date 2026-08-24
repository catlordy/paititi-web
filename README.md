# paititi-web

Static Web shell and immutable release registry for the Godot Web build.

## Publishing model

- `public/releases/<product-version>/` contains an immutable Godot Web export.
- `public/channels/*.json` points a named channel to one exact release.
- The root loader reads a channel manifest and then loads that release.
- `.github/workflows/deploy-pages.yml` publishes `public/` to GitHub Pages.

Run `npm run verify` before publishing. The development channel intentionally has no release until the first locked build is copied into `public/releases/`.
