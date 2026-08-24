# paititi-web

Static Web shell and immutable release registry for the Godot Web build.

The same Pages site also publishes a browser-based PNG editor at
/art-editor/. It uses the File System Access API to edit a user-selected local
checkout of paititi-art; files and credentials are never uploaded to the Web
shell.

## Publishing model

- `public/releases/<product-version>/` contains an immutable Godot Web export.
- `public/channels/*.json` points a named channel to one exact release.
- The root loader reads a channel manifest and then loads that release.
- `.github/workflows/deploy-pages.yml` publishes `public/` to GitHub Pages.

Run `npm run verify` before publishing. The development channel intentionally has no release until the first locked build is copied into `public/releases/`.

## Art editor

1. Open the editor in desktop Chrome or Edge.
2. Select the local paititi-art repository root.
3. Click or drop a PNG onto a missing or existing asset card.
4. Save changes, review the files locally, then run the Git commands shown by
   the editor.

The editor validates the PNG signature, calculates SHA-256, writes the canonical
runtime/ path, and updates asset-manifest.json. It can also add new entries to
asset-slots.json. Direct Git pushes are intentionally outside the browser tool
so no private-repository token is stored in the site.
