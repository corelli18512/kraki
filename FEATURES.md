# Kraki features

Every thing a person can do with Kraki, and what should happen. This is the
list a feature review and a full manual QA pass go through (see
[QA-TEMPLATE.md](QA-TEMPLATE.md)).

**Keep it current.** A pull request that adds or changes something a person
can see or do adds or updates its row here. New rows get the next ID in their
area; IDs are never reused, so old QA reports stay readable.

Platforms: **M** Kraki for Mac · **W** Kraki for Windows · **I** iPhone ·
**B** web (browser / PWA) · **C** the `kraki` CLI.

## A. Install and first run

| ID | What the person does | What should happen | Platforms |
|---|---|---|---|
| A1 | Download and install (Mac: drag from the DMG; Windows: installer; iPhone: App Store/TestFlight; CLI: install script) | Installs with no warnings beyond the system's own; app icon right | M W I C |
| A2 | First launch | Logo intro once, then setup step 1 | M W |
| A3 | Run the app from Downloads or the DMG | Asked to move it to Applications first | M |
| A4 | Setup step 1: coding agents on this computer | Installed agents with their state (ready, sign in, models); Supported agents sheet; Check Again finds an agent installed meanwhile | M W |
| A5 | Full Disk Access | Opens System Settings; continues only when granted; Quit & Reopen resumes the setup | M |
| A6 | Skip — only control other computers | No background service; the app still signs in and shows other computers | M W |
| A7 | Setup step 2: Sign in with GitHub | One click in a sign-in window; code fallback; Cancel goes back; a relay without GitHub accounts says so | M W C |
| A8 | Background service starts | This computer is online in Kraki and on the other devices within seconds | M W C |
| A9 | A command-line Kraki already runs here | Asked which one runs the agents; moving keeps sign-in and sessions | M W |
| A10 | Pair a phone or browser by QR code / link | Scan or open the link; confirm an unknown relay; signed in with the sessions | I B |

## B. Presence (is this computer online)

| ID | What the person does | What should happen | Platforms |
|---|---|---|---|
| B1 | Look at the menu bar / tray | Online or offline at a glance; icon dims offline; dot when sessions need you | M W |
| B2 | Take this computer offline / bring it online from the menu | Service stops/starts; other devices see it at once | M W |
| B3 | Close the window | Stays online in the menu bar / tray; one-time hint | M W |
| B4 | Quit | Asks once (Don't ask again), then goes offline; opening Kraki brings it online | M W |
| B5 | Restart the computer and sign in | Kraki starts in the menu bar / tray only, online, no window; the menu shows the real state | M W |
| B6 | The background service crashes | Back by itself within seconds | M W C |
| B7 | Needs You in the menu | Lists sessions waiting for an approval or answer; clicking opens one | M W |

## C. Sessions

| ID | What the person does | What should happen | Platforms |
|---|---|---|---|
| C1 | Start a session from the composer | Computer / agent / model / thinking pills remembered; Enter starts; the session appears and opens | M W I B |
| C2 | New session (+ / Cmd/Ctrl+N) | Composer focused | M W I B |
| C3 | Read the session list | Title ("New Session" until named), computer, model name, preview, status, time, unread dot — the same on every device | M W I B |
| C4 | Search sessions | Filters by title, preview and computer; empty state | M W I B |
| C5 | Pin / unpin | Pinned on top; synced | M W I B |
| C6 | Rename | From the session menu or Session Info; changes everywhere | M W I B |
| C7 | Mark unread / read | Dot appears / clears; synced | M W I B |
| C8 | Fork | New session "Fork of …" with the same history, on every device | M W I B |
| C9 | Delete | Confirmation; gone everywhere | M W I B |
| C10 | Archive | From the session menu or after N days; Archived group at the bottom; opening one brings it back | M W I B |
| C11 | Import a session started outside Kraki | Lists the agent's sessions on a computer; imports and opens | I B |
| C12 | Keyboard: previous / next session, Session 1–9 | Selection moves | M W |

## D. Chat

| ID | What the person does | What should happen | Platforms |
|---|---|---|---|
| D1 | Send a message | Bubble at once; reply streams; the chat stays at the bottom | M W I B |
| D2 | Type a long or multi-line message | The composer grows, then uses two rows (text above, controls below); never flickers or breaks | M W I B |
| D3 | Steer while the agent works | Composer says Steer; the message joins the running turn | M W I B |
| D4 | Stop the agent | The turn ends with "User aborted" | M W I B |
| D5 | Approve a permission (Safe mode) | Card with the change; Approve / Deny; also works from another device | M W I B |
| D6 | Deny with a reason | Typing while a permission waits writes the deny reason; the reason and "Denied" show in Steps | M W I B |
| D7 | Answer the agent's question | Choices as capsules; tap one or type; the answer stays in the question bubble | M W I B |
| D8 | Switch mode Safe / Auto / Delegate | Header pill; the agent follows it | M W I B |
| D9 | Switch model / thinking | Next turn uses it; the model shows by the same name everywhere | M W I B |
| D10 | Show a turn's steps | Tool steps; each permission once with its outcome; subagent drill-in | M W I B |
| D11 | Attach / paste / drop an image | Thumbnail; the agent sees it; opens large | M W I B |
| D12 | Agent shows a report (HTML) | Card opens a panel; open in the browser | M W I B |
| D13 | Tables in replies | 8-row preview; full table with search, sort, copy | M W I B |
| D14 | Markdown, code, links | Rendered; code copyable; links open in the browser | M W I B |
| D15 | Scroll back through long history | Older pages load without jumps; Jump to latest | M W I B |
| D16 | Send while the computer is offline | The chat says the computer is offline; the message waits and is delivered when it reconnects | M W I B |
| D17 | Session Info | ID (copy), title, model, thinking, usage, fork, delete | M W I B |
| D18 | Agent compacts its context | Indicator while compacting | M W I B |
| D19 | Computer goes offline / comes back | The session shows it; catches up after | M W I B |

## E. Voice

| ID | What the person does | What should happen | Platforms |
|---|---|---|---|
| E1 | First dictation | Cloud notice once before recording | M W I |
| E2 | Dictate and send | Live transcript, level meter, timer; corrected text sent | M W I |
| E3 | Dictate, then Edit | Corrected text lands in the draft | M W I |
| E4 | Cancel dictation | Nothing sent | M W I |
| E5 | Dictate in the new-session composer | Starts a session with the corrected text | M W I |
| E6 | Voice settings and Custom Words | Toggles respected; words added or removed on one device show on the others right away; correction uses them | M W I B |
| E7 | Relay without voice | Settings say voice isn't available; no microphone button | M W I B |

## F. Devices

| ID | What the person does | What should happen | Platforms |
|---|---|---|---|
| F1 | Look at the devices | Each device online or when it was last online, version, agents and models | M W I B |
| F2 | Remove an old device | Confirmation; gone everywhere; this device can't remove itself | M W I B |
| F3 | Connect your phone | QR code and Copy link; closes with a check mark when the phone joins | M W B |
| F4 | A computer has an update | Shown per computer; Update runs on CLI installs; app installs say to update the app. Sessions only waiting for your answer don't hold the update back | M W I B |

## G. Usage

| ID | What the person does | What should happen | Platforms |
|---|---|---|---|
| G1 | Account usage (hold F6 / menu) | Accounts with rings, current session's account first; refresh; honest status | M W I B |

## H. Settings and account

| ID | What the person does | What should happen | Platforms |
|---|---|---|---|
| H1 | Appearance light / dark / system | Applies at once to every window | M W I B |
| H2 | Notifications | Permission state in plain words; reply / needs-you notifications; clicking opens the session | M W I B |
| H3 | General: open at login, usage shortcut | Behave as labeled | M W |
| H4 | Sign out | Confirms; signed out and stays signed out (this computer may keep serving); signing in again works | M W I B |
| H5 | Delete account | Two confirmations; every device signed out; computers stop serving | M W I B |
| H6 | This Mac / This PC | Run agents toggle, status, restart, check agents, version, logs, updates, permissions | M W |
| H7 | About and diagnostics | Versions of every part; Copy diagnostics works | M W I B |

## I. The app itself

| ID | What the person does | What should happen | Platforms |
|---|---|---|---|
| I1 | Update the app | Mac: Check for Updates shows readable notes and relaunches without asking to go offline; Windows: install over, back online | M W |
| I2 | Zoom, toggle the sidebar | Cmd/Ctrl + / − / 0; sidebar hides | M W B |
| I3 | Uninstall | Background service and login item removed; the CLI works again | M W |

## J. CLI next to the app

| ID | What the person does | What should happen | Platforms |
|---|---|---|---|
| J1 | `kraki status / start / stop / restart / setup` while the app runs Kraki | Says the app manages it and where to change that | M W |
| J2 | `kraki connect`, `kraki update` on a CLI install | Pairs a phone; updates in place | C |

## K. Network

| ID | What the person does | What should happen | Platforms |
|---|---|---|---|
| K1 | The relay drops and comes back | "Connecting…" indicator; reconnects within seconds; nothing duplicated or lost | M W I B C |
