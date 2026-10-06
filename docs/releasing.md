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

## Planning

A GitHub milestone per version (`vX.Y.Z`) says which release a ticket ships in; a ticket with no
milestone is backlog. Labels keep saying state, kind and area. Triage sets the milestone along with
the state, and asks when it is unclear.

Below 1.0, a patch release carries fixes only and no **Upgrading** note; a minor release carries
features or any **Upgrading** note. `v1.0.0` is the release from which the CLI, the config and the
run record are held compatible.

A run that works only on one release's tickets:

```bash
sandcastle run $(gh issue list --milestone vX.Y.Z --label ready-for-agent --json number -q '.[].number')
```

At release:

1. The milestone is fully closed, or its open tickets are moved to the next one with a note saying
   why.
2. Check `git log vPREV..HEAD --merges` against the changelog, so no closed ticket is left out.
3. After the release is published, close the milestone and create the next one.
