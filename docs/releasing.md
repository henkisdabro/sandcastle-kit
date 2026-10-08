# Releasing

`package.json` is the source of the current release version. Bump it with
`pnpm version X.Y.Z --no-git-tag-version`: its `version` hook synchronises
`herdr/herdr-plugin.toml`, the site's footer and `SoftwareApplication.softwareVersion`, and the
README's release and minimum Node badges. After a manual edit to `package.json`, run
`pnpm version:sync` yourself. It leaves dependency versions and historical examples alone.

Move the Unreleased changes under the new changelog heading, then run `pnpm version:check` and
the normal checks before committing and tagging `vX.Y.Z`. The check refuses a stale field, a
missing marker or a changelog whose latest release differs from `package.json`. `pnpm test` runs
it too. A new current-version mention belongs in `scripts/version.mjs`'s field list and its
regression test, so future bumps update it. Other badges describe capabilities or live CI status;
check their claims when those capabilities change.

At each release, compare every claim in `site/index.html` and `site/llms.txt` with the last three
release notes and the README. Update the benefits, requirements and FAQ (including its JSON-LD)
for changed behaviour; keep historical run figures labelled as examples. Done when version checks
pass, the visible FAQ agrees with its structured data, and a browser preview has been checked at
desktop and mobile widths.

Pages always deploys `main`, including on release events and manual runs, so an older release's
rerun cannot roll the website back. It checks the committed version fields before uploading the
site; it never replaces them from the nearest git tag. Version-source changes trigger deployment
alongside site changes. After publishing, check the public footer against `package.json`, rather
than treating a successful artifact upload as proof that visitors see the current version.

The kit version counts a clone's distance from its `vX.Y.Z` tag.

The release notes are a short, emoji-led summary, never the changelog pasted in. Copy the shape of
the latest release (`gh release view`) and keep it:

- Title: the bare `vX.Y.Z`. A shared link's card is built from the title and the body's first
  lines (`Release <title> · <repo>`, then the heading, then the start of the first paragraph, cut at
  about 200 characters), so the tagline goes in the body alone, not three times over.
- Body opens with `# 🏰 sandcastle-kit - <tagline>`, the tagline a short lowercase phrase saying
  what the release is about, and no version (the card already shows it twice). Then one short bold
  sentence of about 100 characters, so the card's excerpt ends on it, and a short paragraph on where
  the release came from.
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

Below 1.0, every release is a minor (`v0.N.0`), whatever it carries: fixes, features or
**Upgrading** notes. Releases are cut from main alone, so a patch line would only mean that nothing
from the next minor's milestone had landed yet, and a project takes the kit with a pull and
`/sandcastle update`, which acts on the **Upgrading** notes whatever the number says. A patch
(`v0.N.1`) is only for a hotfix: a fix a release needs at once while main holds work that is not
ready to ship, as v0.4.1 and v0.4.2 were. Two open milestones can still order the work - the fixes
in the next release, the larger changes in the one after. `v1.0.0` is the release from which the
CLI, the config and the run record are held compatible.

A run that works only on one release's tickets:

```bash
sandcastle run $(gh issue list --milestone vX.Y.Z --label ready-for-agent --json number -q '.[].number')
```

At release:

1. The milestone is fully closed, or its open tickets are moved to the next one with a note saying
   why.
2. Check `git log vPREV..HEAD --merges` against the changelog, so no closed ticket is left out. In a
   project with `changelog: true`, run `sandcastle report --changelog --since vPREV` first: it lists every
   ticket the runs landed since the tag with the agents' suggested lines (and those with none), across
   runs, which the last run's closing summary does not.
3. After the release is published, close the milestone and create the next one.
