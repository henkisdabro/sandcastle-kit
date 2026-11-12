# 🪟 Works best in Herdr

What a run lays out in Herdr TUI and in the Herdr app (herdr-core), and the Herdr TUI plugin.


sandcastle-kit runs anywhere, but it is built to be watched from [Herdr](https://herdr.dev), the
terminal multiplexer for coding agents.
Both of its engines work: Herdr TUI (the `herdr` multiplexer) as described here, and herdr-core
(`hc`, the server under the Herdr app) as in [herdr-core](#herdr-core) below.
Start `sandcastle run` in a Herdr TUI pane and the run lays out its own view:

- 🗂️ **A tab of its own.** A run you start by hand, in a terminal that is the only pane of its
  tab, adopts that tab, names it `sandcastle <project>` and puts the status view beside its own
  output. Started anywhere else - by an agent, with `--detach`, into a pipe - it opens a tab itself,
  holding only the status view, and the tab you launched from gets nothing new: a run adopts a tab
  only from a terminal. Either way, a status view an earlier run left is reused where it is
  instead (below). The run prints `Status view: pane <id> (tab <id>)`. An agent starts its
  run with `sandcastle run --detach` and waits for it with `sandcastle wait` (see
  [Detached runs](running.md#-detached-runs)).
- 🚦 **The run in the sidebar.** Herdr cannot see an agent inside a container, so the run
  reports itself. The workspace shows `♜ 4/9 · 1 needs you` (red when something needs you) and the
  tab bar a line per run. The status view's pane is one agent, `sandcastle` titled `<project> run`:
  *working* while the run goes, then at its end *blocked* when a ticket is held, failed or
  conflicted, else *idle*. A `not landed` or `conflict` ticket that a later autonomy turn re-runs by
  itself is not counted as needing you while the run goes (its pane, with sandbox panes on, reads
  *idle* and names the ending); the view's last report, at the end of a turn, counts it, as the next
  turn's view reports again if one follows.
  While the run spends a subscription on a Claude model, that pane also reports
  the plan's usage as an `$sc_usage` token (`5h 14% · wk 93% ■`; `▲` from 75%, `■` from 90%, which the plugin's sidebar row colours amber and red, and nothing is sent before an agent has
  reported one). With cross-review on a ChatGPT plan the token joins both providers' weekly windows
  (`claude wk 93% · codex wk 16% ■`), the mark that of the worst window of either.
- 🧱 **A pane per sandbox, if you want them.** `herdr: { panes: "all" }` in `.sandcastle/config.ts`
  (or `SANDBOX_PANES=all` for one run; the variable wins) stacks one pane per concurrent sandbox
  on the right of the status view, named after its ticket and following that sandbox's log
  through implement, review, gates and repair. Each is reported as an agent named after its
  ticket (`#12 Add CSV export`): *working* while it implements, reviews or gates, *done* when its
  pipeline finishes - ready to land or red, the outcome is in the message - and *blocked* only
  when a human has to act: a crash, a merge conflict, a branch held for a human merge (a conflict or
  failed landing that a later autonomy turn re-runs by itself reads *idle*, naming the ending). With the
  [plugin's sidebar rows](#the-herdr-plugin) each sandbox also shows its step and how long it has
  been at it. Once nothing is left to start, each pane closes as its sandbox finishes (a crashed
  one stays open). The default is `"none"`: five sandbox panes crowded the tab, and the status
  view says the same, better.
- 🔔 **A notification** with the run's summary when it ends. Outside Herdr, set `notify` in
  your [personal settings](configuration.md#personal-settings) to get one.

When the run ends its sandbox panes (if any) close, so nothing in the sidebar outlives it; the
status view stays, showing each branch's outcome, and the next run reuses that pane rather than
stacking another: the view stays where you put it, run after run, in whatever tab you moved it to
and at the size you gave it (when the pane is still there, the same terminal, in the run's
workspace, and idle or still showing the status view or report; a pane running your own command is
replaced, and so is one Herdr restarted).
The earlier run's sandbox panes close.
A run killed outright (the machine going down, or a `kill -9`) leaves its tab as idle shells when
Herdr comes back, whether Herdr restarts at the same moment or some time after the kill: with the
plugin's tab bar, the first tick that finds the status pane a bare shell runs `sandcastle report`
there, in a tab the run opened (never one adopted from your terminal), once.
Until then the status view, still running, shows how the run ended.
A restart mid-run (a detached run outlives it) brings the status view back: the tab bar's next tick
that finds the status pane a bare shell starts it there again.
A run that ends after a restart, or is stopped by the hangup of a closing Herdr, reports in its tab
the same way.
A finished run whose tab is still to be told waits out of the tab bar's way: the plugin looks at
that tab when Herdr starts, and on the ticks while another run is going, never otherwise, and
forgets it 7 days after the run ended.
So the report of a finished run is typed when the tab's status pane is a bare shell at one of those
looks: at the next Herdr start, or on a tick while another run is going.
A status view that stops on its own (it crashes, say - not a Ctrl-C, below) with no Herdr restart
and no other run going leaves the report waiting for the next of either; run `sandcastle report` in
that pane to read it at once.
A look at which herdr cannot answer (the server not yet restored at Herdr's start, say) is not the
end of the wait: the tab is tried again at the next one.
Quitting the status view yourself (Ctrl-C in its pane) is different: that pane stays your shell
until the run ends or Herdr restarts - nothing is typed into it while the run lives, nor the report
once it has ended.
After a Herdr restart the tab bar brings the view back as above.
Outside Herdr none of this happens and nothing else changes - watch with `sandcastle status` in a
second terminal.
`SANDCASTLE_HERDR_VIEW=0` skips the tab; the status view then opens in a pane beside yours.

In an adopted tab the status view gets about half the screen: run pane 25%, status view 50%,
sandboxes (with `panes: "all"`) 25% in one column of equal rows (status below the run pane on a
narrow screen; 2/3 in a tab of its own, and all of it with no sandbox panes).
The run never moves your focus: it works in the background until you switch to its tab.

## herdr-core

Started in a herdr-core terminal, by hand or with `--detach`, the run opens its status view as a
core terminal split into that tab, and prints `Status view: terminal <id>`.
It never adopts the tab or opens one.
The kit talks to herdr-core alone (`hc`), so the Herdr app, and any other client of herdr-core,
shows the same thing:

- 🚦 **The run in the sidebar.** The status terminal reports the run as an agent: *working* while it
  goes, *blocked* while a ticket needs you, during the run or after it (the app raises its own
  needs-you alert; a `not landed` or `conflict` ticket that a later turn takes by itself reads
  `later` - "retried next turn" - until the run's last turn or its end, and keeps the root
  *working*; its slot terminals read *idle*, not *blocked*, the same way), else *done* at the end
  (*error* when the run ended early), with the merged share of the run as its progress and the run line as its title.
- 🧱 **A terminal per sandbox.** Each running sandbox gets a terminal of its own, following its
  ticket's log and reporting its ticket and step. By default it is a sub-agent of the status view
  with no pane: the Herdr app lists it under the run's agent, named after the project and ticket
  (`shop-12`), and a click on it there peeks at it, as does a Ctrl-click (Cmd-click on macOS) on
  its address in the status view's note (`terminals: #12 t8`). `herdr: { panes: "all" }` (or
  `SANDBOX_PANES=all`) gives each one a pane beside the status view instead, titled with its
  ticket and step. Each ends with its sandbox, and on its own within seconds of a run killed
  outright.
- ♻️ **The same view, run after run.** The status terminal stays when the run ends, showing how it
  ended, and the next run of the project finds it by name: while it shows the status view, a bare
  shell or a view you quit (with `q`), it is replaced by a fresh view beside you, under the same
  name; a terminal running your own command keeps it, and the run's view opens beside you
  instead, unnamed.
- 🛰️ **A detached run outlives its terminal.** From hc 0.1.19, `sandcastle run --detach` started in
  a herdr-core terminal keeps running when that terminal closes (an older hc ended it with the
  terminal).
  A terminal opened before the update to 0.1.19 keeps the old behaviour until it is recreated.
  `sandcastle doctor` warns on an hc older than 0.1.19.

What Herdr TUI's plugin does has no herdr-core counterpart yet: no tab bar line or ticket card
(a Ctrl-click on a ticket opens nothing; on a terminal address it peeks, as above), and no status
view brought back after a restart of the core (the status terminal comes back as a shell, and the next run replaces it; `sandcastle status` there shows the run
meanwhile).
`sandcastle herdr ...` in a herdr-core terminal says so.
`SANDCASTLE_HERDR_VIEW=0` opens no sandbox terminals; the status view still opens.
The app shows a run only when it starts in one of the app's terminals: started from Terminal.app
or another terminal outside the app, a run opens no view there (`sandcastle doctor` says so).

A command counts as running in herdr-core only when the terminal `HC_TERMINAL_ID` names is one of
its own ancestors, so a stale variable a Herdr TUI server or a core started from the other inherited
is never followed; otherwise Herdr TUI's own rule applies (`HERDR_ENV=1`).
`sandcastle doctor` names the host it found.

## The Herdr plugin

The kit ships a [Herdr plugin](https://herdr.dev/docs/plugins) in `herdr/`. It is optional, and
nothing above needs it. One command sets it up:

```bash
sandcastle herdr configure            # shows what it adds, asks, then does it
sandcastle herdr configure --remove   # takes all of it out again
```

It links the plugin from the kit's own checkout (no build step: a `git pull` of the kit updates it),
appends one marked block to Herdr's `config.toml`, and reloads Herdr's config.
Nothing restarts and no pane is touched.
`sandcastle setup` and `/sandcastle update` offer it wherever Herdr TUI is installed - from a Herdr
TUI tab, a herdr-core terminal or a plain terminal - with yes as the default answer, and
`sandcastle doctor` says whether it is in place.
Nothing installs it without asking: it edits your own Herdr config.
It serves Herdr TUI tabs only.
Without Herdr TUI installed none of this exists, and nothing asks.
What you get:

| | |
|---|---|
| `prefix+shift+s` | The status view over whatever tab you are in, full size. `q` or Esc closes it and puts you back where you were. |
| `prefix+shift+e` | The last run's report (`sandcastle report`) as a popup: `q` closes it, and its bottom line says so. |
| `prefix+shift+a` | "Sandboxes first" in the Agents panel, and back: whatever needs attention first, then the sandboxes. Herdr forgets it on a restart; the plugin puts it back. |
| Ctrl-click a ticket | In the status view (the run's tab or `prefix+shift+s`), the ticket numbers are links once the plugin is linked, and the view's note says which key opens them (below). The ticket's card opens in a popup: its number, title, state and how long it has been in it; one line per pass in its last run (implement, review, gates, repair - each attempt -, resolve, landing gates) with its outcome and time; the reason it is held or in conflict, or the last lines of its red gate's log. A digit opens that pass's log: it follows the log live (new lines appear at the bottom as the agent writes them), and `Ctrl-C` closes it, as its bottom line says (`less` reads no other key while it follows; Esc does nothing in it); a log shorter than the popup opens from its top line and does not follow, `q` or `Ctrl-C` closes it, with `F` to follow new lines. Closing the log puts the card back. `t` prints the ticket's tracker link (its GitHub issue, from the `origin` remote, or its ticket file), and `q`, Esc or `Ctrl-C` closes the card. A ticket the last run did not take shows its logs, and says so. |
| Sidebar rows | The run's workspace shows `♜ 4/9 · 1 needs you`, red when something needs you; with sandbox panes on (`panes: "all"`), each sandbox shows its step and time (`review · 12m`); and the run's own agent shows the plan's usage (`5h 14% · wk 93% ■`), amber from 75% and red from 90%. A kit that wrote its block before this row existed needs `sandcastle herdr configure --yes` again to show it |
| Tab bar | Every live run on the machine, from any tab: `♜ shop 4/9 · 2 working · 1 needs you`. |

**Which click.** The key depends on the terminal Herdr runs in, not on Herdr: Ctrl-click works in
Terminal.app and Ghostty, but in iTerm2 it is macOS's right-click and never reaches Herdr, and
Cmd-click opens the log there instead (iTerm2 opens the link itself, so the log, not the card).
A pane cannot see that terminal, so when `sandcastle status` starts a view it looks once (never per
redraw) at the Herdr clients attached to the view's own server - one `ps` listing of your own
processes, and `herdr session list` - and reads the terminal from their environment (`TERM_PROGRAM`,
`LC_TERMINAL`, `VTE_VERSION`, `KITTY_WINDOW_ID`, `WEZTERM_EXECUTABLE`). iTerm2 gets
`cmd-click a ticket for its log`, Terminal.app and Ghostty `ctrl-click a ticket for its card`;
anything else - WezTerm, Kitty, a Linux terminal, no client found, or clients in terminals that
disagree - gets `ctrl-click a ticket for its card (iTerm2: cmd-click for its log)`.
If the guess is wrong, set it: `"herdr": {"clickHint": "ctrl"}` (or `"cmd"`; `"auto"` senses, the
default) in your [personal settings](configuration.md#personal-settings), or `SANDCASTLE_CLICK_HINT` for one view,
which wins.
`sandcastle doctor` and `sandcastle herdr configure` say which terminal was sensed and which hint
the view will show.

The prefix is Herdr's, `ctrl+b` unless you changed it. The keys work on the project of the focused
pane; from a pane in no project, on the run going (with several, the one whose tab is in this
workspace, else Herdr asks you to focus the one you mean). They open only when you press them: a
run never opens one. The link a Ctrl-click follows must be a log file in some project's
`.sandcastle/logs` (the card is that log's ticket's), each log is paged with no shell escape, and
the card draws no control sequence from a title, note or log, as an agent's log can print links too.

With or without the plugin, a run at autonomy level 1 that asks whether to run tickets again
marks its own pane as waiting for you, so Herdr's sidebar and notifications say so like for any
agent with a question.

If your `config.toml` already sets sidebar rows (`ui.sidebar.agents` or `ui.sidebar.spaces`), tab
bar entries or one of the three keys, `configure` changes nothing and prints the block for you to
merge by hand; comment lines do not count, so a config saved from `herdr --default-config` is fine.
After writing, it asks Herdr to reload the config and puts the file and the plugin link back as
they were if Herdr says anything new about it. The previous file is kept as
`config.toml.sandcastle-kit.bak`.

Herdr cannot dock a plugin in its sidebar (plugins get terminal panes and popups, not native
panels), so the sidebar carries the run through the values it reports, and the full view stays a
pane. Sidebar rows belong to the Herdr you look through: if you watch a remote machine's Herdr from
your own, run `configure` on both - the plugin and the tab bar on the machine running the kit, the
rows on yours.

With `herdr: { panes: "all" }` and a run started by hand, the tab looks like this (by default it
holds the status view alone):

```
┌ you ───────────────────────────────────┐   tab "sandcastle my-app"
│ your agent / shell                     │   ┌ sandcastle my-app ───────┬ #12 Add rate limiter ──┐
│ $ sandcastle run                       │   │ #12 ● review   3m  2 ... │ Bash(pnpm test)        │
│ 2 ticket(s), up to 2 at a time ...     │   │ #15 ● impl     1m  0 ... │                        │
│ Gates on main: lint=pass test=pass     │   │ #18 ○ queued   not in .. ├ #15 Fix date parsing ──┤
│ [impl-12] Started ...                  │   │                          │ Edit(src/date.ts)      │
└────────────────────────────────────────┘   └──────────────────────────┴────────────────────────┘
                                              sidebar: #12 review ● · #15 implement ●
```
