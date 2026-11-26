# Using Peacock

The full guide to the desktop app. For a short tour, see the [README](../README.md).
Menu and button names are given as the English UI shows them; the app also runs in
Korean (Settings > General > Language).

## GJC setup details

GJC is one of the agents Peacock runs, not a requirement. When GJC is the agent
chosen at first launch, the app installs it if it is missing (see the
[README](../README.md#install)).
GJC `0.18.12` or newer is required for GJC sessions (the newest verified
compatibility target is `0.19.0`); to install it yourself, run GJC's installer:

```bash
curl -fsSL https://raw.githubusercontent.com/Yeachan-Heo/gajae-code/main/scripts/install.sh | sh
```

The app is version `0.2.0`; that is the desktop app release version and is
separate from the GJC CLI version. Update each independently.

Lookup order for the executable:

1. `GJC_BIN`
2. Path set in Settings > Agents > GJC (Executable)
3. `$GJC_INSTALL_DIR/gjc`
4. `PATH`
5. `~/.local/bin`, `~/.bun/bin`, `~/.nvm/current/bin`, `~/.volta/bin`,
   `/opt/homebrew/bin`, `/usr/local/bin` (a Finder launch has none of these on `PATH`)

Bun is needed only when `gjc` is a Bun launcher script (a Bun global or source
install), not for the release binary.

The default model preset is `codex-medium` (Settings > Agents > GJC, Model profile). If
`~/.gjc/agent/models.yml` defines it, that mapping wins. The same card holds the
default approvals, sign-in and the GJC update check; the other GJC pages (detailed
settings, MCP servers, skills and plugins, usage, automations) are linked from it.

## Conversations

Type a request and press Enter. A message takes up to 5 files and 6 images (10 MiB each). Files are sent as local paths. In a GJC chat, images are uploaded to GJC (`turn.image.*`) and reach the model as images with the prompt, on one `gjc sdk serve --stdio` relay per message, because GJC keeps a staged image only on the connection that uploaded it. PNG, JPEG, WebP and still GIF up to 20 MiB qualify. A message with any other image, a GJC without image uploads, or an upload GJC refuses sends its images as local paths instead, which the model opens with GJC `read`. Images sent into a running turn (steer) also go as paths. An omp chat sends images in its prompt along with their local paths, and other files as
paths in the text.

A finished turn keeps its request and final answer on screen and folds everything
between them into one line, such as `Worked for 4m`, with a failure count (`1 failed`)
when a tool failed. Click the line to open the work in order. A running turn, a turn
without a final answer, and a turn still waiting on a question or an approval stay
open. A turn that finishes while your viewport is inside its work stays open too, so
the text you are reading does not move. The Details view never folds. Rows carry clock
times like `13:22`, so the duration is counted in minutes.

The conversation display menu in the header sets how much each turn shows:
Summary (tool summaries), Default (tool cards) and Details (reasoning expanded too).

## While a turn is running

| Action                | Result                                                                                                      |
| --------------------- | ----------------------------------------------------------------------------------------------------------- |
| Text + Enter          | By default, hold the follow-up visibly above the input. It waits until the current turn ends, unless you press empty Enter again. Settings > General > Conversation > Enter while a turn runs can make Enter steer instead |
| Empty Enter (with work held) | Interrupt the current turn and immediately release the held work through steering                         |
| Send now on a held row | Send that instruction as a steer without stopping the current turn; other held rows keep waiting |
| Edit / × on a held row | Restore that request to the draft / discard only that request |
| Arrows on a held row  | Move that request earlier or later in the queue |
| `⌥↑` / `⌥↓`          | Pull the newest / the oldest held request back into the draft |
| `/steer …`            | Hold a visible Steer row above the input; Send now delivers it to the open turn |
| `/queue …`            | Mark the held work to wait until the current turn ends                                                    |
| Esc or Stop           | Stop the current turn and owned background/subagent work. The session stays open                          |

The submit slot holds one button, not two: the send arrow whenever there is
something to send, otherwise Stop. The Composer owns one local held-work queue;
Both `/queue` and `/steer` hold work locally while a turn runs. The saved
steer-on-Enter preference also creates a visible Steer row rather than bypassing it.
An omp chat additionally lists the messages omp itself holds for the running turn
(see [omp chat](#omp-chat)).

The working row under a running turn shows how long it has run. After 30 seconds
with no new output, streamed text included, it also says when the last activity
was. When the newest row is a message sent into the running turn, it says the
message is read when the current step finishes. The count starts when this window
first sees the turn running.

When a model call fails and GJC or omp waits to send it again (rate limits,
dropped connections), the working row reads "Model error" and shows the attempt,
the time left before the next one, and the first line of the error. In GJC, Retry
now skips the wait (`retry.now`); Stop retrying ends it (`retry.abort`) in both.

GJC `turn.steer` is consumed at the next tool/turn boundary, so it is not a wait
queue. Held requests appear as full-width rows above the input, with Send now,
edit, and discard controls. Send now does not abort; empty Enter retains its
separate interrupt-and-release behavior. Failed deliveries remain visible for
review rather than being automatically resent.

## Model / effort

- `/model` — open the model picker
- `/model codex-medium` — switch immediately. An exact name or a unique prefix of a profile or model name matches. Unknown names are not sent as chat; they show an error
- `/effort` — open the thinking-level menu
- `Shift+Tab` — cycle thinking effort

The picker is one searchable list with the thinking level under the search box. In a
GJC chat it lists the profiles (built-in and custom) and the models, with starred
favorites on top, and shows Fast on/off controls when the session advertises
`service_tier.set`. `/fast` or `/fast toggle` toggles configured intent; `/fast on`,
`/fast off`, and `/fast status` are also available. Configured Fast intent does not
prove a provider applied priority service. In an omp chat it lists omp's models with
the provider, context size, speed and price columns omp reports, recent models
first; omp's fast mode is one of its run modes (see [omp chat](#omp-chat)).

## Reasoning cards

Reasoning cards follow one window-wide preference instead of per-card state:
Expand on any card expands every reasoning card, including later turns and other
sessions, and Collapse collapses them all. The value persists in
`agent-control-settings.json` and can also be set in Settings > General >
Conversation > Keep reasoning expanded. Streaming cards keep their header,
`Thinking…` label and spinner, and follow the same setting for their content.

## Slash commands and skills

The command palette combines desktop actions (`/steer`, `/queue`, `/abort`,
`/compact`, `/new`, `/login`, `/resume`, `/model`, `/effort`) with controls advertised by
the live GJC SDK. An omp chat lists omp's own commands instead, and has no
`/login` or `/resume`. `/skills` lists session skills, `/skill:<name> <request>` submits skill
work, `/progress` reads project progress, `/reload` reloads runtime components, and
`/plan on|off` changes plan mode when those SDK operations are available (GJC chats). Skill
work follows the same held-work rules as prompts; session controls execute immediately.

On attachment, skills are discovered from `skill.list/state` until the runtime
publishes its authoritative command list. The palette also requests that context
when it opens, but reuses a read from the last 15 seconds so reopening it does not
spawn another pair of CLI processes. Until the live list arrives the palette keeps
the bundled commands and says that skills are loading. GJC 0.18.12 does not expose a complete
CLI slash-command registry query, and its skill rows can omit visibility metadata.
An authoritative command update replaces that provisional skill list. TUI-only
commands and commands without a public SDK equivalent are not claimed as supported;
desktop slash commands are not a complete copy of the CLI command surface.

## Side chat (`/btw`)

`/btw <question>`, the header's Side chat button, or `⌘⇧B` opens a panel beside the
conversation. The agent answers from the session's context and saves nothing, so
the conversation gains no row: GJC answers through `btw.ask`, omp over RPC with its
own `btw`. It works while a turn runs and does not affect that turn. Follow-ups
are typed in the panel. GJC remembers nothing between side questions, so each
follow-up carries the panel's earlier answers, as many of the newest as fit in
12 KiB. One question is answered at a time. Each session keeps its own questions
until the window closes. In a narrow window the panel covers the conversation. A
remote device sends `/btw` as before and gets the answer as a conversation row.
`/btw` is never held behind a running turn. Side chat needs a GJC that advertises
`btw.ask` (0.19.3 or later); on an older GJC the panel says so instead of taking a
question.

## Next-input suggestion

When a turn ends normally and the composer is empty (no draft, attachment or held
request), a likely next message appears in it as ghost text. Tab takes it, Esc
dismisses it, and typing anything drops it. In a GJC chat it is asked of the
session's own model through `btw.ask` and follows GJC's `promptSuggestions`
setting: with that off no request is made. An omp chat asks omp's own side
question (`btw` over RPC) once per finished turn. Either way it runs only while
the window is visible and focused, and a suggestion that has not arrived after 30
seconds is dropped. Other agents' chats offer none.

## Away recap

In an omp chat, a completed turn that then stays quiet for four minutes (omp's
own default `recap.idleSeconds`) gets one more side question: a short "where
things stand" recap. It arrives as a `While you were away` notice in the
transcript, so a returning user can catch up without rereading the turn. It is
asked only after a completed turn, at most once per turn, and never while
another turn or queued work is live. GJC chats do not have it.

## File mentions

Type `@` at the start of the draft or after a space to search the session
workspace's files (a message takes up to 5 files). ↑/↓ moves the highlight, Enter or Tab attaches the file, and Esc
closes the list without stopping the run. The `@text` leaves the draft and the file
becomes a path chip, sent the same way as a file chosen with the attach button.

The list comes from `git ls-files --cached --others --exclude-standard`, so
`.gitignore` decides what is offered. Outside Git it is a bounded directory walk
that skips `.git` and `node_modules`. Either way it stops at 100,000 files and says
so. The main process reuses a listing for 10 seconds, so files written since then
appear on the next `@`. Mentions are desktop only: a remote device has no workspace
listing, and `@` stays plain text there.

## Shortcuts

| Key         | Action                |
| ----------- | --------------------- |
| `⌘T`        | New session: opens one on the default agent in the current folder at once (in a new worktree of the project when Settings > Projects says so), or the new-session dialog when the folder is a broad one (home, Documents, Desktop) or unknown |
| `⌘1`–`⌘9`   | Select a session in sidebar order |
| `⌘K`        | Search every session and message |
| `⌘F`        | Find in this conversation (not in a terminal) |
| `⌥⌘U`       | Inbox |
| `⌃⌥Space`   | Quick input from any app (the default; see [Quick input](#quick-input)) |
| `⌘⇧B`       | Side chat |
| `⌘↵` / `⌘⌫` | Allow / reject the focused approval card |
| `1`–`9`, Enter | Answer a question card |
| `Tab`       | Accept the suggested next message (GJC) |
| `Shift+Tab` | Cycle thinking effort |
| `⌥↑` / `⌥↓` | Pull the newest / oldest held request back into the draft |
| Esc         | Stop the current turn (a dialog or panel takes Esc first; a terminal gets it as a key) |

The macOS menu has the same `⌘T` and `⌘1`–`⌘9`.

## Links from other apps

Raycast, Alfred, a shell `open`, or any other app can hand Peacock a link:

| Link | Action |
| ---- | ------ |
| `peacock://new?prompt=…&path=…` | Opens the new-session dialog with the folder and first request filled in |
| `peacock://session/<id>` | Opens that session |

`gajae://`, the scheme from before the rename, still works the same way.

Both parameters of `new` are optional. The dialog creates nothing until it is
confirmed, and the first request is placed in the new session's message box, never
sent. A link with a `prompt` opens the dialog on GJC, since only GJC takes a
handed-over request; one with only a `path` offers every agent. `path` must be an absolute path to an existing folder; a relative or missing
path, a request over 20,000 characters, or a session id the window does not know is
refused with a notice instead of opening anything. Other `peacock://` links are
ignored. A link works whether Peacock is running or not: one that starts the app is
held until the window has loaded, and a second launch hands its link to the running
instance. The packaged app registers both schemes in its `Info.plist`; a development
`electron .` run does not register it, and `npm run desktop:deep-link-smoke` drives
the handlers instead.

## Quick input

`⌃⌥Space` opens a small window over whatever app is in front. Settings > General >
Desktop > Quick input shortcut changes the keys or turns the shortcut off. The
window collects a request, the project it belongs to (most recently active first)
and up to six screenshots: its camera button captures a screen region, which needs
macOS Screen Recording permission for Peacock (after allowing it, Peacock may need
to be reopened). Enter hands the text, the project and the screenshots to the
new-session dialog in the main window. The dialog opens on GJC, because only GJC
takes screenshots and a handed-over request, and nothing is sent until you confirm
it and send in the new session.

## Inbox

The inbox button next to the search box (`⌥⌘U`) lists, across every project, what
waits for an approval or an answer, what failed, what finished since you last
looked (Newly finished) and what is still running. Automation runs appear there
too. It lists every session that reports its state, whichever agent runs it, and
opening a session from it marks that session read.

## Session delete

This section is about GJC sessions; terminal and omp sessions are covered below.

Delete targets saved history, not its host process and not just the sidebar row.
Peacock requests `session.delete` with the exact session ID, configured location and
transcript path; it never calls `session.close` to make deletion possible. This
preserves a CLI that may have switched to another conversation with `/new`.
The CLI picker can delete old history through its owning `SessionManager`, but
GJC 0.19.0's public SDK still does not expose that owner-local flow; saved history
deletion and its unknown-outcome fence are described under
[GJC SDK session CLI compatibility](development.md#gjc-sdk-session-cli-compatibility). A refusal
or unknown outcome leaves the row and local evidence intact and shows an error;
use that CLI's session picker for owner-local history deletion.

When the broker cannot settle the delete (an unknown outcome, or the
`lifecycle_legacy_history_ambiguous` fence that gjc/0.19.2 raises for every
delete once the agent dir's lifecycle ledger holds legacy rows), Peacock deletes
through GJC's own interactive `/session delete` instead
(`electron/gjc-cli-session-delete.ts`). `gjc -p` does not run slash commands
(it sends them to the model), so Peacock opens the transcript with
`gjc --resume <path> --no-mcp --no-lsp` in a hidden terminal, with
`GJC_AUTOMATION=1` so first-run onboarding does not open over the editor. It
types the command, chooses Yes only on GJC's own deletion prompt with Yes
already selected, presses Esc on any other dialog, and stops GJC once the
transcript is gone. That also discards the empty session GJC opens after
deleting. It never edits the ledger. It does this only for a saved transcript
that no host is running.

A session another GJC holds open (usually an interactive `gjc` in a terminal) is
deleted from the app too. The delete confirmation names that GJC (its terminal
and pid, read from the broker row's `pid` and checked with `ps`) and offers
"Stop GJC and delete"; the answer is bound to that pid, so if a different process
holds the session when the delete runs, nothing is stopped and the user is asked
again. Peacock sends that GJC SIGTERM, waits up to 10 s for it to exit (it is
never SIGKILLed), waits for the broker to drop `live`, then deletes as above. A
row still marked `live` whose process is gone holds nothing and is deleted
without asking to stop anything. A GJC stopped this way can exit before
releasing its session-store lock, and gjc/0.19.2 reclaims a dead owner's lock
only after its 60 s lease, answering `/session delete` with "Another session
migration is still active" until then; the hidden terminal starts over in a new
GJC every 10 s, up to six runs. If GJC exits, times out (45 s per run) or shows a
prompt it does not expect, the session stays recovering and nothing local is
removed.

`node scripts/gjc-cli-delete-e2e.mjs` (also the `cli-delete-e2e` step of
`npm run gjc:matrix`) reproduces the fence with a legacy ledger row in a
throwaway HOME and agent dir and deletes through the real GJC: a saved session
in about 14 s, and a session held by an interactive `gjc --resume` in a pty in
about 15 s, or about 70 s when that GJC left its lock behind (6 of 6 runs passed on 0.19.2, two of them slow).

Right-clicking a row also offers Hide from list, which removes only the row and
leaves GJC's history alone. It is offered for GJC sessions only.

Other agents: Delete on a terminal session (Claude Code, omp, Codex, a shell)
asks first, ends its terminal and removes the session from Peacock; the agent's own
transcript file stays where the agent keeps it. Delete on an omp chat removes it
from the list and stops its omp process; omp's session file stays in omp's
history, where a terminal can resume it. Delete on any session started in a worktree Peacock
made also asks whether to remove that worktree and its branch (see
[Sessions in their own worktree](#sessions-in-their-own-worktree)).

## Agent sessions

New session (⌘T, or + for the dialog) asks which agent the session runs: Claude Code,
omp (Oh My Pi), Codex, GJC, or a shell. The dialog starts on the agent and screen
chosen last; before anything was chosen, on the first installed of Claude Code,
omp, Codex and GJC. Settings > General > New session > Default agent sets that
default directly (an agent and its screen, such as "Oh My Pi · Chat"), or sets it back to
automatic; ⌘T opens a session on it at once. A request handed over with the dialog
(quick input, or a link with a `prompt`) always opens GJC and does not change the
default. A settings file from before agents could be chosen keeps opening GJC
(`newSessionKind: "app"`) or a shell (`"cli"`).

The dialog's other fields: Session name; Approvals, for Claude Code and omp;
Where to work, for any agent in a Git folder (work directly in the folder, or in a
separate copy, a managed worktree with an optional branch name — see
[Sessions in their own worktree](#sessions-in-their-own-worktree)); and Folder. For GJC,
a folder as broad as home, Documents or Desktop is warned about before the session starts.

- **Screens.** Claude Code opens on its terminal. omp opens on its terminal or on
  its chat ([omp chat](#omp-chat)): the dialog's "Opens in" choice is made when the
  session is created, and a session does not change between the two. Codex and the
  shell have only the terminal. GJC is the app conversation.
- **Approvals field.** For Claude Code (`default`, `acceptEdits`, `plan`,
  `bypassPermissions`) and omp (`always-ask`, `always-ask-cached`, `write`, `yolo`) the
  dialog offers an approval mode for the session. "Agent default" (the default)
  passes no flag, so the agent's own settings decide; for an omp chat the default is
  "Ask every time", because its cards are how it asks.
- **Defaults per agent.** Settings > Agents has a card per agent. It shows where the
  agent was found and its version, or why it cannot run. An executable set there
  wins over the search (PATH, the login shell's PATH, then where the agent's
  installer puts it). Claude Code, omp and Codex can also start with a default
  model, effort and approvals (omp takes no effort; Codex's approvals stay in
  Codex); the dialog's Approvals overrides the default one, and changes apply from
  the next new session. GJC's card holds its executable, model profile, default
  approvals, sign-in and update (`GJC_BIN` still wins over its executable setting).
  omp's card manages its sign-in (see [omp chat](#omp-chat)); Claude Code and Codex
  sign in through their own terminals.
- **Terminals.** Agent and shell terminals run in herdr-core, outside the app:
  switching sessions or quitting the app leaves them running, and the session
  reattaches with what it printed. Settings > Advanced shows whether herdr-core is
  running, and Background terminals > End all ends every one. When herdr-core
  cannot run, a shell session falls back to an in-app shell; an agent session shows
  the error instead.
- **Approvals and status.** Claude Code and omp report their turns and tool
  approvals to Peacock: the sidebar shows running, waiting and idle, notifications
  follow, and an approval waits on a card in the window or on a paired phone.
- **Changed files.** A Claude Code, omp or Codex terminal session has a changed-files
  button in its header, next to the branch the folder is on; it opens the same panel as a
  GJC chat beside the terminal, read from the session's folder with `git diff HEAD`. A shell
  has none. Stage, Unstage, Commit and Push work only in a managed worktree, so only a session
  started in a [separate copy](#sessions-in-their-own-worktree) can use them; in a session
  started in its folder as it is, the panel reads and says so. Push never goes to the
  repository's default branch, and a branch with no upstream gets its first push to `origin`
  (`git push -u origin HEAD`), which sets the upstream; after a push, the panel can
  [open a pull request](#opening-a-pull-request-from-a-session). Comments on diff lines are
  sent back as one review typed into the terminal, for Claude Code and omp while they report
  their state (Codex cannot take one, so its panel has no Send review). If the agent is
  waiting on a dialog in its terminal (a folder trust question, an approval) it does not take
  the typed review: the panel says it was not sent, keeps the comments, and Send review tries
  again once you have answered. The panel and the branch follow the session: they are read when
  you select it, when one of its turns ends and when the window gets focus back, not on every
  status change, and an open panel is read again at the same moments.
- **Remote access** lists Claude Code, omp and Codex sessions; a shell never
  leaves the desktop. A phone reaches no terminal, so there a Claude Code or omp
  terminal session opens as a chat built from the agent's transcript file.
- **Search** (⌘K) covers Claude Code and omp sessions too: their rows are read
  from the agents' own transcript files, and a file that grew while no window
  followed it is noticed before the next search answers. A shell or Codex
  session has nothing to search.
- The [Inbox](#inbox) lists every session that reports its state. The model
  picker, thinking level and Fast tier belong to chats (GJC and omp); Claude Code,
  Codex and the shell choose their model in their own terminal, and Settings > Agents
  sets the one they start with. Parallel runs can drive Claude Code and omp (see
  [Parallel runs](#parallel-runs-best-of-n)).

The app keeps agent and shell sessions in `terminal-sessions.json` and omp chats
in `omp-rpc-sessions.json` under its user data, since GJC does not know about them.
A session started in a worktree keeps its worktree in that record.

### Sessions in their own worktree

Any agent can start in a new Git worktree of the folder's repository instead of in the
folder itself: pick "Work in a separate copy" (the other choice is "Work directly in this
folder") under "Where to work" in the new-session dialog, with an optional "Branch name",
or let the project do it for you.

- **Where.** The worktree is made next to the repository, in
  `<repo>.gajae-worktrees/<id>`, and the session opens in it. The branch is the one
  typed in the dialog, or a new `peacock/<id>` branch from `HEAD` for Claude Code, omp,
  Codex and a shell (GJC keeps its own `gajae/<id>`). A branch that must already exist,
  and a fork's pull request, are still GJC's, so a request started from an issue or a CI
  run opens GJC. A terminal session (Claude Code, Codex, a shell, omp on its terminal) needs
  herdr-core for this, and the window reports it when herdr-core is not running; an omp chat
  does not.
- **One click.** Settings > Projects keeps, for each project (a repository's main working
  tree, shared by its worktrees): "Start new sessions in a new worktree", a "Setup script"
  and "Files to copy". With the first on, ⌘T makes the session in a new worktree on a
  `peacock/<time>-<salt>` branch, built from the project's main working tree whichever
  worktree is open, and the new-session dialog opens on "separate copy" (the radio can
  still be switched). A folder outside Git is not affected. A session that is being
  prepared shows in the rail as starting ("Preparing worktree…") until its worktree is
  ready; if the worktree cannot be made, that row is marked failed and the window says why.
- **Files to copy.** Files the repository does not track (`.env`, local config), one path
  per line, relative to the project folder. They are copied into each new worktree before
  the setup script runs. A path that leaves the project folder, names `.git`, or is a folder
  is refused; a symbolic link, a file over 10 MiB, one Git tracks, one the worktree already
  has and one the project does not have are skipped. Only a file that could not be copied
  is reported.
- **Setup script.** A shell script run with `/bin/sh -c` in the new worktree, after the copy:
  for example `npm ci`. `PEACOCK_ROOT_PATH`, `PEACOCK_WORKTREE_PATH` and
  `PEACOCK_WORKTREE_BRANCH` are set. It stops after 10 minutes and only the end of its output
  (32 KB) is kept. It is what you wrote in Settings, kept in the app's data folder and never read
  from the repository, and saving a new or changed script asks for confirmation first.
  A script that fails or times out, or a file that could not be copied, does not stop the
  session: it opens anyway and the window says what did not go as asked.
- **Claude Code** asks whether to trust a new folder, and so may another agent. Nothing is
  typed into the session for you, so the question is waiting in its terminal; answer it there.
- **Forks and git.** A fork of an omp chat stays in its worktree. An omp chat in a managed
  worktree can stage, commit and push from its changed-files panel, as GJC and a terminal
  session in a managed worktree can.
- **Deleting the session.** After you confirm Delete, a second question asks "Remove this
  session's worktree too?" for a worktree Peacock made, and only then. Its text names every
  loss: the uncommitted files, commits on no branch, and the unpushed commits of a branch
  Peacock made, with the folder and branch it would delete. "Remove the worktree too" removes
  them; "Keep it" deletes only the session and leaves the worktree and branch where they are.
  Nothing is asked, and nothing removed, when
  - the session was started in its folder as it is, or in a worktree of your own, or in the
    repository's main working tree: only a single folder directly under
    `<repo>.gajae-worktrees/` that Git lists as a linked worktree is ever removed, and never a
    locked one;
  - another session is still using the worktree, a fork of this one or a session of any agent
    in its folder: the worktree goes with the last of them;
  - the session is only being hidden (GJC's Hide from list), because its history resumes in
    that folder.

  What you agreed to is read again after the session and its agent have ended, and carried
  out only if it is exactly what the question showed: an edit or commit made in between, or a
  session that started using the worktree meanwhile, keeps it, and the window says so (the
  session is deleted either way). The order is: the agent's terminal or process ends, the
  worktree is removed, Git's record of it is pruned, and then the branch is deleted, and only
  a branch Peacock made for this worktree (`createdBranch` in the session's record). A branch
  that was already there when the worktree was made, a branch checked out in another worktree,
  and a session recorded before this was kept (its branch is read as not Peacock's) are never
  deleted; the question says which branch stays. A worktree whose folder is already gone only has
  Git's record pruned. A branch you moved the worktree onto is not deleted either, so work
  committed there survives.
- Settings are in `project-settings.json` in the app's data folder. This is desktop only: a
  paired phone cannot start sessions, in a worktree or otherwise.

## omp chat

Choosing Oh My Pi and Chat in the new-session dialog makes an omp chat. Peacock
runs `omp --mode rpc-ui` for it: one process per session, started when the session
is opened or a message is sent and ended when the app quits. Opening the session
again resumes it with `--resume`. The chat has no terminal. An omp terminal
session (the dialog's Terminal choice) stays terminal-only.

- **Conversation.** Replies stream in with reasoning (with how long omp thought),
  tool cards with run time and, for edits, a diff that folds past 12 lines, and the
  same question cards GJC uses: omp's forms become one card per field.
- **Approvals.** The mode chosen in the dialog applies (`always-ask` unless you
  picked another). A card offers Allow once, Allow for this session (omp remembers
  that grant, or its folder or file grant under `always-ask-cached`) and Deny. A
  Deny note reaches omp as a follow-up message, since omp's prompt takes only a
  label; it appears in the chat as a message of yours. A project command rule
  answers a matching bash call without a card, as in GJC.
- **Status line.** Above the composer: how long the turn has run, what it is doing
  now (the running tool, thinking or writing) and the todo list (click the count
  for the checklist).
- **Context.** A bar above the composer shows how full the context window is. Its
  details button opens a dialog with the context by category (system prompt, system
  tools, instruction files, skills, messages, the auto-compaction buffer and free
  space) and the session's cost, model calls, tokens and tool calls. The dialog and
  the bar also offer Compact now. The breakdown is omp's own `/context` report; omp
  gives no finer split of the messages.
- **Run modes.** The same bar has Fast mode, Slow mode (only on models that support
  it), Auto-compaction and Auto-retry switches. Auto-compaction and auto-retry apply
  to this session only; omp does not report auto-retry, so it shows its default or
  the value last set in this window.
- **Queue.** The messages omp holds for the running turn (steering first, then
  follow-ups) are listed above the composer. A follow-up can be sent now, and any
  item removed. This is separate from the composer's own held requests.
- **Subagents.** The header's Subagents button opens a panel of running, waiting and
  finished subagents with their task, model, cost, time, tool count, context use and
  latest activity. A running or waiting one can be stopped or told more; Show
  conversation reads its messages.
- **Goals.** `/goal <objective>`, `/goal pause`, `/goal resume`, `/goal drop` and
  `/goal show` drive omp's goal mode, which uses the same goal row as GJC. omp has no
  Complete operation, so the row has none; a goal does not start the next turn by
  itself over RPC.
- **Conversation tree.** The header's Conversation tree button lists the messages
  in reading order, the current branch first and others indented. Move here goes to
  any entry within the same session file; your own messages also offer Rewrite from
  here (back to that message, its text returned to the composer) and Fork up to
  here (a new chat that ends at that message, nested under the original). The
  sidebar's Fork from current state works on an omp chat too. omp refuses to move
  while a turn runs.
- **Shell commands.** `!command` runs in omp's shell and `!!command` runs it without
  adding the output to the model's context; the card says "Run by you" and has a
  Stop button. One runs at a time.
- **Changed files.** The header's changed-files button opens the same panel as a GJC
  chat, read from the chat's folder with `git diff HEAD`; Stage, Unstage, Commit
  and Push work only in a managed worktree, as in GJC: a chat started in a
  [separate copy](#sessions-in-their-own-worktree) is in one, a chat in its folder as it is is not.
  The panel then goes on to [a pull request](#opening-a-pull-request-from-a-session), as in GJC.
- **Side chat.** `/btw` and `⌘⇧B` work as in GJC.
- **Next-input suggestion.** After a completed turn the composer offers a likely
  next message as ghost text; Tab takes it, Esc dismisses it. It costs one side
  question per turn.
- **Away recap.** A finished turn that stays quiet for four minutes gets a
  `While you were away` recap notice, as in omp's own TUI.
- **Sidebar menu.** Export as HTML saves the conversation through a save dialog.
  Renaming the chat renames the omp session too.
- **Sign-in.** Settings > Agents > Oh My Pi > omp sign-in lists omp's providers and
  accounts, signs in (omp opens the browser for OAuth) and signs an account out
  after a confirmation. omp keeps the credentials; Peacock never stores them.
- **Not in omp chats.** The session info panel, `/login` and `/resume`, and a
  terminal screen.
- **Delete.** Removes the chat from the list and stops its omp process; omp's
  session file stays in omp's history.

## Resume a session

Eligible interactive GJC root sessions publish an SDK endpoint automatically
(unless `GJC_SDK_DISABLE=1`). The app and CLI can use that same live host through
public broker query/control routes. Attaching does not resume, replace, or change
the permission policy of an externally owned live session.

If a shared route is unavailable, the transcript remains readable. The internal
`terminal-only` state means an unavailable control route, not proof of exclusive
terminal ownership. Fresh positive endpoint evidence is checked with a public
metadata query so a recovered route is not permanently stuck read-only.
Opening history with a stale/unavailable endpoint succeeds only when the saved
transcript can actually be read, and explicitly displays
"History view only · No execution connection". This does not claim that execution resumed;
permission failures and missing/unreadable history are not replaced with an empty
successful conversation. Repeated transcript refreshes retain the warning until
control is restored.
"Continue session" (in the row's right-click menu) also retries attachment on user
action; only a non-live session is re-hosted. Creating a different session or exiting a reachable terminal is not
required for ordinary shared interaction.

Operator-owned Stop has a separate GJC authority requirement: a directly launched
TUI can answer queries and steering while lacking the indexed lifecycle identity
required for terminal/owned-work abort. When the operator route is refused but the
host still answers, Stop falls back to the ordinary `turn.abort` and the cancellation
notice states that this host's background work is not confirmed stopped; the window
never claims it, and no signal or process kill is substituted. A refused release
(Empty Enter) hands the held work over as a steer instead of failing.

## Permission handling

GJC's default approval is set in Settings > Agents > GJC > Default approvals: Ask
before commands (the default), GJC smart policy, or Always allow. It is applied after
create or resume with the public `permission_mode.set` session control operation.
`always-allow` and `auto` (the smart policy) map to the broker-hosted session's
`allow` mode. There is no environment variable on a desktop-owned agent child
because Peacock has no agent child.

Ask before commands (`prompt`) uses GJC's external approval channel, which gjc/0.19.3 and
later advertise. Peacock turns it on with `permission.channel.set` for each session
it hosts, so a tool call that needs approval waits instead of failing:

- The call's card shows the request with GJC's options (allow once, always allow,
  reject, always reject). A rejection can carry a note, which GJC hands the agent
  as the tool's result.
- While the session runs, Peacock lists waiting requests every 0.75 s over one
  `gjc sdk serve --stdio` relay per session, and answers with `permission.respond`.
- GJC drops a request it waited 60 s on, or one whose turn was stopped. The card
  then stops waiting and the call's own result shows what happened.
- A remote device with control permission answers the same card; a view device
  cannot.
- Always allow and always reject are GJC's own per-tool choices for that session.

On a GJC without the channel there is still no way to ask, so Peacock fails closed
instead of silently granting tools: the session is placed in deny mode, and denied
cards point to the setting.

Claude Code and omp ask in their own way; their default approvals are the
Approvals field of the new-session dialog and each agent's card in Settings > Agents.
Settings > Approvals gathers the rest: each agent's default approvals (with a note when one runs
without asking), whether a paired phone may answer, and the command rules.

**Command rules.** On an approval card for a bash command, Always allow this prefix
and Always reject this prefix save the command's start (editable on the card) as a rule
for that project, shared by its worktrees. Matching commands are then decided
without a card and say so on the call, in GJC, omp and Claude Code sessions alike. An
allow rule never covers a command that chains, pipes, substitutes or redirects; that
one still asks. A reject rule errs the other way and also fires on a matching command
inside a chain. Settings > Approvals > Command rules
lists the rules and deletes them. `⌘↵` and `⌘⌫` allow and reject the focused card.

## Open a past session

"Continue a previous session" re-hosts the selected session with the
`session.resume` lifecycle global. Open it with `/resume` in a GJC chat (omp chats
have no such picker). The picker lists past sessions read straight
from the session files under
`~/.gjc/agent/sessions/` (`GJC_CODING_AGENT_DIR` overrides the root), because
discovery drops non-live sessions on purpose.

- Search by session id prefix, title, or workspace
- Ids show 12 characters; 8 collide across real sessions
- Every saved session is offered: summaries are read from a bounded head with an
  eight-way worker pool, and the picker renders 100 rows per page on demand
- A long first request is summarised to one line and deep paths are shortened, so
  a row cannot push the id and time out of the dialog

Choosing a session closes the picker right away. The row is created even when
attaching is refused, so the failure is reported on the session rather than
holding the dialog open.

The full session id sits under the title in the inspector and copies on click.

## Projects and the repository screen

The rail opens on "All projects" and can be filtered to one project. Its Project /
Status switch groups sessions by project or by state, and sessions waiting on you sit
at the top either way. A project is a
Git repository's main working tree, so every linked worktree of the same repository
— including a Peacock managed worktree — belongs to the same project instead of
appearing as a second one. A workspace outside Git is still a project: it keeps its
sessions and its own root, and the repository screen says it is not a repository
rather than showing an empty one.

"View repo" sits next to the selector whenever one project is selected; from
"All projects" the same place offers "Projects" (the project list), because the whole
rail has no single repository to open. The repository screen fills the center area:

| Tab | What it reads |
| --- | --- |
| Overview | current branch, worktree and branch counts, changed-file counts per worktree, connected sessions, GitHub issue/PR counts and default-branch CI, sessions started from an issue or CI |
| Issues | open issues, then one issue's body and labels |
| PRs | open pull requests with review state and CI, then one pull's branches, diff size and reviews |
| Branches & worktrees | local branches, which worktree has each checked out, and each worktree's changed-file count |

- Selecting a session returns to its conversation with the project still selected.
- Filtering the rail never closes the open conversation. A session from another
  project stays on screen with no row highlighted until a session of the selected
  project is picked.
- "View repo" is offered for any selected project, including one outside Git, and the
  screen then says the project is not a repository. The project list leaves the entry
  point out for such a project, because its row already says the same thing.
- A worktree row lists the sessions whose workspace is that checkout root. A session
  started in a subdirectory of a worktree is grouped into its project but gets no chip
  there: a managed worktree lives inside its source repository, so a prefix join would
  also list its sessions under the main worktree.
- A local Git read that fails is reported as its own sentence, and only a path Git
  itself refuses reads as "This is not a Git repository." — a repository that could not be read
  is never drawn as one without branches.
- Right-click on "View repo" carries the auxiliary actions only: "Open on GitHub"
  and "Open local folder".
- "Changed files" reuses the session's existing panel, so Stage / Unstage / Commit /
  Push and the pull request step are the same code, prompts and managed-worktree checks as the
  conversation's "View changed files" button. Nothing on the repository screen writes on its own.
- "Start a session for this issue" on an issue and "Fix failing CI" on a pull request (or on the
  overview, for the default branch) open the new-session dialog filled in; the
  session is created only when the dialog is confirmed, and the first request is
  placed in its message box, not sent. The issue's request carries its title, body,
  labels and URL on branch `issue-<number>-<slug>`. The CI request carries the
  failed steps' log from `gh run view --log-failed` for up to three Actions runs,
  cut to the last 32 KB. A worktree that already has the branch checked out is
  used as it is; otherwise a managed worktree checks out the existing local branch
  rather than creating a second one. A CI fix never starts its branch from `HEAD`:
  the branch must exist locally or on one remote, or creation stops and asks for a
  `git fetch`.
- The session remembers the issue, pull request or CI run it was started from, and
  the overview lists those sessions. A `gh` failure while reading the CI log leaves
  the button disabled beside the same sentence used everywhere else on the screen.

GitHub reads go through the [`gh` CLI](https://cli.github.com), which supplies its
own credential from the keychain. The app never reads, stores or prints a token, and
every read is a `gh` subprocess whose failure is reported as a state. (The one write,
[opening a pull request](#opening-a-pull-request-from-a-session), goes through `gh` the same way.)

- "No remote repository. This project is local only." — the project has no remote configured
- "This is not a GitHub repository. Issues and pull requests are only available on GitHub." — the remote is not github.com
- "GitHub CLI (gh) was not found. Install it to view issues and pull requests." — `gh` is not on `PATH` (`GAJA_GH_BIN`
  overrides the path for a packaged install)
- "Not signed in to GitHub. Run gh auth login in a terminal." — run `gh auth login`
- "Could not connect to GitHub. Check your network." — DNS, TLS, timeout or proxy failure
- "GitHub did not respond. Try again shortly." — anything else the API answered

An empty issue or pull list is none of those: it is reported as an empty list.

### Opening a pull request from a session

The changed-files panel of a session in a managed worktree takes work from commit to pull
request without leaving the app: Stage, Commit, Push, then a **Pull request** step below them.
It works the same for a GJC chat, an omp chat and a Claude Code, omp or Codex terminal session,
and only in a worktree Peacock made for the session.

- **Push.** The Push button is on whenever the branch has something to send: a branch with no
  upstream yet (every new worktree branch) or one that is ahead of its upstream. The first push is
  `git push -u origin HEAD`, which creates the branch on `origin` and sets it as the upstream, so
  later pushes are plain. The confirmation says where it goes. A branch that tracks another name
  (one started from `origin/main`) gets its own first push instead of failing. The repository's
  default branch is never pushed from here: the panel refuses, and the work goes in through a pull request.
- **Pull request.** Once the branch has an upstream, the step looks up the branch's open pull
  request with `gh`. If there is one, the panel shows its link and CI state (passing, failing,
  pending or none) and nothing else; "Refresh PR status" reads CI again, and the step also reads
  when a turn ends. If there is none and every commit is pushed, "Create PR" opens a form with the
  latest commit's title and message as the title and description. Edit them and confirm: the host
  asks first, naming the repository, `base ← head` and the title. The new pull request then shows
  as a link with its CI state. A branch that has commits not pushed yet asks you to push first.
- **Forks.** A branch pushed to a fork opens its pull request in the fork's parent repository, from
  `you:branch` into the parent's default branch; the step and the confirmation say so.
- **What `gh` is asked.** `gh repo view` and `gh pr list --head <branch>` to look up, and
  `gh pr create --repo --head --base --title --body-file` to open. `gh` never prompts: login,
  editor and browser questions are switched off, and the description goes in a temporary file that is
  removed afterwards, so what you type cannot become a command-line option. Opening may wait up to
  90 seconds, longer than the 25 seconds of a read. A missing or signed-out `gh`, no remote, a
  non-GitHub remote and a network failure show the sentences listed above, with the reason `gh`
  gave (any token in it removed).

## Parallel runs (Best-of-N)

The new-session dialog no longer starts parallel runs. Existing groups still
open in the comparison described here, and a run can still be started through
the desktop bridge (`window.agentControlDesktop.parallel.start`).

A run's attempts can be GJC sessions or (`agentKind`) Claude Code or omp
sessions. `parallel.agents()` says which agents can drive a run here and why
not for the rest: a shell runs whatever is typed, Codex has no transcript to
compare, and an agent that is not installed cannot start. For a terminal agent:

- Each attempt's preset is the agent's model, or `default` for the agent's own
  default; `launch` sets the other options (permission mode, effort) for every
  attempt.
- Peacock makes each attempt's worktree and branch itself, in the same place GJC
  does (`<repo>.gajae-worktrees/`), and opens the agent there. No window has to
  show it: the terminal starts in herdr-core, and the request is typed in once
  the agent is at its prompt. Claude Code asks whether to trust a folder it has
  never seen, and that dialog is left to you: the attempt waits (up to ten
  minutes) until it is answered in the attempt's terminal, and fails with what
  the agent was waiting on otherwise.
- The comparison reads each attempt's changes from its worktree (`git diff HEAD`
  and untracked files). Cleanup ends a removed attempt's terminal and deletes
  its session; the agent's own transcript file stays. A run of 2-4 attempts gives each
attempt its own managed worktree, a new branch (`<branch>-1`, `-2`, … or
`gajae/best-of-<id>-N` without a name) and its own model preset, and the first
request is sent to each attempt once. More than one attempt always uses worktrees.
A CI fix does not offer the option, because its attempts would start from `HEAD`
instead of the failing branch, and a branch name that already exists is refused
before anything is created.

- Attempts are created one after another, because each creation writes the
  source repository's `.git` and the broker's lifecycle ledger. Each request is
  sent as soon as its session exists, so the attempts run at the same time. An
  attempt that fails to create, or whose request did not run, is shown as failed
  while the others keep running.
- `session.create` takes the attempt's preset as `modelPreset`, which GJC 0.19.0
  resolves as an exact profile ID. The comparison shows the preset the runtime
  reports and marks one that differs from the request.
- The rail nests the attempts under one group row, with the same code that nests
  forks. The row opens the comparison: each attempt's state, changed-file count,
  context usage and its own "Changed files" panel, side by side.
- "Adopt this attempt" keeps that attempt's branch and worktree and merges nothing. Commit,
  push or open a PR from its panel later.
- Removing the other attempts always goes through the host confirmation. It
  names each worktree and branch, the uncommitted files `--force` would discard,
  and the commits on a branch that are on no remote and no other local branch.
  Cancelling removes nothing and "Clean up the rest" asks again. What is removed is read
  from Git again after the confirmation, and nothing is removed if it changed.
  A running attempt is refused until it is stopped. The removed attempts' sessions
  are hidden from the rail; their GJC history is not deleted.
- The group is one record in `agent-control-sessions.json`. If the app quits while
  attempts are being created, the unfinished ones are marked failed on the next
  start.

## App updates

Settings > General > Update shows the installed version and whether a newer release
exists on GitHub, with a check button. Peacock checks once a day and tells you once
per version (the New version alerts switch); it downloads nothing until you ask.
When a release is out, an Update button appears beside Settings. It downloads the
release ZIP, checks it against the SHA-256 published with the release, unpacks it,
and quits; a helper then swaps the app bundle in place and reopens Peacock, leaving
the old bundle in use if the copy fails. This works from a packaged app in a folder
Peacock may write to (for example `/Applications`); a development run only links to
the release page. The `install.sh` installer does the same from a terminal (see the
[README](../README.md#install)).
