# Releasing

A release bumps `version` in `package.json`, `herdr/herdr-plugin.toml` and `site/index.html`'s
`data-version` with its changelog heading (tests check all four agree), then tags `vX.Y.Z`: the
kit version counts a clone's distance from that tag.

The release notes are a short, emoji-led summary, never the changelog pasted in. Copy the shape of
the latest release (`gh release view`) and keep it:

- Title: `🏰 sandcastle-kit vX.Y.Z - <tagline>`, a short lowercase phrase saying what the release
  is about.
- Body opens with `## 🏰 vX.Y.Z - <tagline>`, then one bold sentence and a short paragraph on
  where the release came from.
- Then `### ✨ New`, `### 🐛 Fixed` (a `### 🔒 Security` section before it when there is any),
  `### ⬆️ Upgrading` (starting with `/sandcastle update`), `### 🙏 Built on Sandcastle` (the
  thanks to Matt Pocock), and `**Full diff:**` with the compare link.
- Each bullet starts with an emoji and a bold or short lead, then a dash and one line. Pick the
  handful of changes a user notices, and end Fixed and Upgrading with a link to the changelog's
  version anchor for the rest.
