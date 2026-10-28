# Releasing

New versions are published by the maintainer as releases in this repository. The installed app looks for updates there (configured in `electron-builder.yml` and `src/main/updater.ts`).

Publishing needs the GitHub CLI, logged in with write access to the repository (`gh auth login`).

1. Merge the changes into `main`, then set the new version: `npm version minor` (or `patch`). This commits the version number and tags it.
2. Build and publish:

```bash
npm run release
```

The script stops if there are uncommitted changes or the version's tag isn't the current commit. Then it pushes the commit and tag, builds the installer and the portable exe, and publishes the release with notes listing the changes since the previous release. Edit the notes on GitHub afterwards if you like.
