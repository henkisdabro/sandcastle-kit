// The project website against the README it advertises. The site is hand-written HTML with no
// build step, so nothing else notices when the README's install line changes and the landing
// page keeps telling people to paste the old one, or when an FAQ answer is edited on the page but
// not in the structured data search engines read.
//
//   node --test test/site.test.ts

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const KIT = join(import.meta.dirname, "..");
const html = readFileSync(join(KIT, "site/index.html"), "utf8");
const readme = readFileSync(join(KIT, "README.md"), "utf8");

const text = (s: string) => s.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/^\$\s*/, "").trim();

test("the footer's version is the changelog's latest release", () => {
  const released = /^## \[(\d+\.\d+\.\d+)\]/m.exec(readFileSync(join(KIT, "CHANGELOG.md"), "utf8"))?.[1];
  assert.match(html, new RegExp(`<span data-version>v${released}</span>`), "bump site/index.html's data-version with each release");
});

test("every install line on the site is the README's", () => {
  const install = readme.match(/^git clone https:\/\/github\.com\/henkisdabro\/sandcastle-kit\.git .*$/m)?.[0];
  assert.ok(install, "the README's quick start has no install line");
  const onSite = [...html.matchAll(/<code>(.*?git clone.*?)<\/code>/g)].map((m) => text(m[1]));
  assert.ok(onSite.length > 0);
  for (const line of onSite) assert.equal(line, install);
});

test("the author credit links back with rel=author, its tracking intact, and no nofollow", () => {
  assert.match(html, /<a href="https:\/\/www\.henriksoderlund\.com\/\?utm_source=sandcastle-kit&amp;utm_medium=referral&amp;utm_campaign=oss-sandcastle-kit&amp;utm_content=footer-author-link" rel="author">/);
  // The fragment comes after the query string, or the tracking is lost.
  assert.match(html, /expertise\?utm_source=sandcastle-kit&amp;utm_medium=referral&amp;utm_campaign=oss-sandcastle-kit&amp;utm_content=more-work-link#showcase-projects"/);
  assert.doesNotMatch(html, /nofollow/);
});

test("the FAQ's structured data asks and answers what the page does", () => {
  const ld = JSON.parse(html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)![1]);
  const faq = ld["@graph"].find((n: { "@type": string }) => n["@type"] === "FAQPage");
  const onPage = [...html.matchAll(/<details>\s*<summary>(.*?)<\/summary>\s*<p>([\s\S]*?)<\/p>/g)].map((m) => [text(m[1]), text(m[2]).replace(/\s+/g, " ")]);
  const inData = faq.mainEntity.map((q: { name: string; acceptedAnswer: { text: string } }) => [q.name, q.acceptedAnswer.text]);
  assert.deepEqual(inData, onPage);
});
