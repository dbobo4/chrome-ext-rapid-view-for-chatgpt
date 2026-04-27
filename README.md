# Rapid View for ChatGPT

Rapid View for ChatGPT is a Chrome Manifest V3 extension that keeps long ChatGPT conversations usable by locally virtualizing older turns. It archives heavy historical DOM into lighter local snapshots, keeps the newest turns live, provides manual or dynamic archive readers, and can save the currently detected conversation as a local TXT file.

## Project Overview

Long ChatGPT threads can become expensive for the browser when many rich answers, tables, code blocks, and historical turns remain mounted at the same time. This project solves that page-side performance problem with a local virtualization layer:

- detects the active ChatGPT conversation thread
- groups page content into turn-aware records
- archives older turns into lightweight local representations
- removes or hides heavy historical live DOM
- renders an archive UI for reading, copying, restoring, and switching archived views

The extension is intentionally local-first. It does not add a backend service; speed mode and TXT export both run from the active ChatGPT tab, with export handled as a local browser download.

## Main Capabilities

- Local virtualization for long ChatGPT conversations on `chatgpt.com` and `chat.openai.com`
- Turn-aware archive records that preserve user and assistant message boundaries
- `Manual` mode with batch restore through `Load N older`
- `Dynamic` mode with a sliced archive reader and timeline navigation
- Per-record `Simple` and `Rendered` archive views
- Global archive controls for collapse, load all, all-simple, and all-rendered actions
- Visual user-to-assistant pair bridging in both manual and dynamic readers
- Structured archived code blocks with separate language labels, rendered code bodies, and clean copy values
- Copy buttons that copy the code body instead of the visual language/header label
- Expandable simple previews through `Show full simple`
- Popup-triggered TXT export for the active detected conversation
- Popup status reporting for `Active`, `Ready`, `Searching`, `Disabled`, `Unavailable`, and error states

## How It Works

The extension is built around a content-script runtime that attaches directly to the ChatGPT page after document idle.

1. **Conversation detection**
   - The content script locates the active ChatGPT thread and detects message/turn nodes from the page structure.

2. **Record building**
   - Detected nodes are converted into internal records with role, turn metadata, fallback text, snapshot state, estimated height, and archive render state.

3. **Activation decision**
   - The extension stays passive on smaller conversations.
   - Archive mode activates when the thread crosses built-in size thresholds:
     - `18` detected turns, or
     - about `6500px` estimated content height
   - It can deactivate again when the thread drops below lower thresholds.

4. **Live-tail preservation**
   - The newest `4` turns remain live by default.
   - Manual mode uses a smaller archived/live boundary internally so older turns can be restored in controlled batches.

5. **Archive rendering**
   - Older turns are rendered into archive blocks.
   - Archive blocks can be shown as simple text or richer rendered snapshots.
   - User turns followed by assistant turns are visually grouped with a narrow bridge so related pairs scan as one unit.

6. **Code block preservation**
   - Code block collection uses the code content root when available, normally the nested `<code>` subtree.
   - The language/header label is stored separately from the code body.
   - The archived `<pre><code>` content and the copy value use the code body, not the header label.

This keeps the current conversation tail interactive while giving older content a controlled, cheaper representation.

## Reader Modes

### Manual

Manual mode keeps an explicit archive list and restores older records in batches. It is useful when you want predictable control over which older turns become visible again.

Implemented manual-mode behavior includes:

- `Load N older` batch restore
- `Load all` for restoring all indexed archive records
- `Collapse all` for reducing expanded archived content
- `All simple` and `All rendered` bulk view switching
- visible turn-pair bridging between adjacent archived `user -> assistant` records
- scroll-preserving incremental insertion when older records are loaded

### Dynamic

Dynamic mode uses a sliced archive reader for large histories. Instead of restoring a long static list, it creates a lighter navigable archive surface with timeline dots and preview labels.

Implemented dynamic-mode behavior includes:

- slice-based archive window rendering
- timeline dots for moving through archived records
- hover previews for timeline entries
- paired user/assistant spacing
- bridge rendering between related `user -> assistant` records
- lighter rendering for archived history while preserving the live tail

## Archive Views

### Simple

Simple view is the lighter plain-text-oriented archive representation. It is optimized for scanning and for keeping large archived sections cheap to display. Long simple content can be expanded with `Show full simple`.

### Rendered

Rendered view preserves more of the original ChatGPT formatting when a rich snapshot is available. It is intended for content such as structured answers, code examples, tables, and formatted assistant responses.

## Code Block Handling

Archived code blocks are treated as structured UI fragments rather than plain copied text from the whole code-block container.

- The language/header label is detected from structural code block UI where possible.
- The actual code body is extracted from the content root, preferring nested `<code>` content.
- Header elements are omitted from the archived code body.
- The archive header can still display the language, for example `PowerShell` or `properties`.
- The `Copy` button reads from the archived code body, so copied commands do not include the language label.
- Archived code is rendered with `textContent` into `<pre><code>` for stable plain-text display.

This is especially important for command blocks where copying a visual label such as `PowerShell` would break the command.

## Privacy and Data Handling

Rapid View for ChatGPT is designed as a local-only browser extension.

- The manifest requests only the `storage`, `downloads`, and `offscreen` permissions.
- Host permissions are limited to:
  - `https://chatgpt.com/*`
  - `https://chat.openai.com/*`
- `storage` is used for extension settings.
- `downloads` is used only to open Chrome's local save flow for `chatgpt_extracted_conversation.txt`.
- `offscreen` is used only to create and hold a local TXT Blob URL while Chrome's Save As flow is active.
- Archive snapshots and export text are generated locally in the active tab/session.
- There is no backend server in this repository.
- There is no custom network pipeline or upload step for exporting conversation content.

## Repository Structure

```text
.
|-- manifest.json
|-- assets/
|   |-- icon16.png
|   |-- icon32.png
|   |-- icon48.png
|   `-- icon128.png
|-- src/
|   |-- background/
|   |   `-- service-worker.js
|   |-- content/
|   |   `-- content-script.js
|   |-- offscreen/
|   |   |-- download.html
|   |   `-- download.js
|   |-- popup/
|   |   |-- popup.html
|   |   |-- popup.css
|   |   `-- popup.js
|   `-- shared/
|       |-- constants.js
|       `-- settings.js
|-- LICENSE
`-- README.md
```

### Important Files

- `manifest.json` - Chrome Manifest V3 metadata, permissions, popup registration, and content-script wiring
- `src/background/service-worker.js` - Blob URL lease and cleanup coordinator for TXT export
- `src/content/content-script.js` - main runtime for page detection, archiving, virtualization, archive rendering, code block handling, manual mode, and dynamic mode
- `src/offscreen/download.html` and `src/offscreen/download.js` - offscreen document used to create and revoke export Blob URLs
- `src/shared/constants.js` - version, message types, export filename, default settings, runtime statuses, and activation limits
- `src/shared/settings.js` - storage-backed settings normalization, load, save, reset, and change listener helpers
- `src/popup/popup.html` - popup structure for enable state, TXT export, reader mode selection, and status display
- `src/popup/popup.css` - popup visual styling
- `src/popup/popup.js` - popup settings, status, export request, and local download wiring

## Runtime Architecture

The runtime is intentionally simple: there is no bundler and no external package dependency. A small background service worker and offscreen document are used only for reliable TXT Blob URL lifecycle management.

```text
ChatGPT page
  -> content script loads shared constants and settings
  -> page detector finds the active conversation
  -> records are built from detected turns
  -> archive thresholds decide whether virtualization activates
  -> older turns are indexed/snapshotted
  -> archive UI renders manual or dynamic reader mode
  -> popup reads settings/status and requests TXT export text
  -> background service worker asks offscreen to create a Blob URL
  -> popup starts Chrome Save As with chrome.downloads.download
  -> background/offscreen revoke the Blob URL after download completion or timeout
```

The implementation is mostly custom DOM engineering. The distinctive part of the project is not third-party integration, but the page-side state management needed to keep a changing ChatGPT DOM usable under long conversations.

## Settings and Defaults

Current defaults are defined in `src/shared/constants.js`.

| Setting | Default | Purpose |
| --- | ---: | --- |
| `enabled` | `true` | Enables the extension runtime |
| `liveTurnCount` | `4` | Number of newest turns kept live in the normal tail |
| `restoreBatchSize` | `4` | Number of older records restored by each manual load action |
| `archiveDefaultRendered` | `false` | Starts archives in simple mode by default |
| `dynamicScroll` | `false` | Uses manual mode by default |

Important activation limits:

| Limit | Value |
| --- | ---: |
| Activate by turn count | `18` turns |
| Deactivate by turn count | `12` turns |
| Activate by estimated height | `6500px` |
| Deactivate by estimated height | `5000px` |
| Manual live turn count | `2` turns |
| Simple preview cap | `1200` characters / `14` lines |

The popup currently exposes enable/disable and manual/dynamic mode selection. Other defaults are internal constants rather than editable popup fields.

## Setup

There is no build step in the current repository. Load the project directly as an unpacked Chrome extension.

1. Clone or download this repository.
2. Open `chrome://extensions`.
3. Enable **Developer mode**.
4. Click **Load unpacked**.
5. Select the project root:

```text
D:\Python\my_side_projects\chrome_chatgpt_speed_booster
```

After changing `manifest.json`, background/offscreen files, or the content script, reload both pieces that Chrome keeps cached:

1. Click **Reload** for the unpacked extension in `chrome://extensions`.
2. Reload the open ChatGPT tab so the new content script runs in the page.

## Usage

1. Open a ChatGPT conversation on `chatgpt.com` or `chat.openai.com`.
2. Open the Rapid View for ChatGPT popup.
3. Keep the extension enabled.
4. Choose `Manual` or `Dynamic`.
5. Continue using the conversation normally.
6. When the conversation becomes large enough, the extension switches into active archive behavior.
7. Use the download icon in the popup header to save the currently detected conversation as `chatgpt_extracted_conversation.txt`.

Popup status meanings:

- `Searching` - the active page is still being detected
- `Ready` - the extension is attached but archive mode is not currently active
- `Active` - older turns are being archived/virtualized
- `Disabled` - the extension is disabled in settings
- `Unavailable` - the current tab is unsupported or no content-script status is available
- `Error` - popup status retrieval or runtime state failed

Manual archive actions:

- `Load N older` restores the next hidden batch.
- `Load all` restores all available archived records.
- `Collapse all` collapses expanded archived content.
- `All simple` switches visible archived records to simple mode.
- `All rendered` switches visible archived records to rendered mode.

TXT export:

- The popup asks the active tab's content script for the current internal turn list.
- The popup asks the background/offscreen path to prepare a temporary Blob URL, then the visible popup starts Chrome Save As through `chrome.downloads.download`.
- The background service worker tracks the prepared Blob URL lease and revokes it after the download completes, is interrupted, is explicitly released, or times out.
- The downloaded file contains only role-labeled turns, for example `USER TURN` and `ASSISTANT TURN`, plus simple text content.
- The export omits route data, timestamps, internal record IDs, pair bridges, archive controls, timeline UI, copy buttons, and code-header UI.
- Code blocks prefer the structured code body where available, so visual labels such as `PowerShell` or `properties` are not added to the code text.
- If export fails, the popup download icon briefly enters an error state and the popup DevTools console logs the exact reason, such as a missing extension reload, stale ChatGPT tab, unsupported tab, or empty export source.

## Validation

The current repository uses lightweight validation rather than a full browser automation suite.

Useful static checks:

```powershell
node --check src\content\content-script.js
node --check src\popup\popup.js
node --check src\shared\constants.js
node --check src\background\service-worker.js
node --check src\offscreen\download.js
git diff --check -- manifest.json README.md src\content\content-script.js src\popup\popup.html src\popup\popup.css src\popup\popup.js src\shared\constants.js src\background\service-worker.js src\offscreen\download.html src\offscreen\download.js
```

Recommended manual smoke checks:

- Reload the unpacked extension in `chrome://extensions`.
- Reload the active ChatGPT conversation tab.
- Open a long ChatGPT thread.
- Confirm popup status transitions from `Searching` or `Ready` to `Active` when thresholds are met.
- In manual mode, use `Load N older` and verify user/assistant pairs remain visually grouped.
- In dynamic mode, use timeline dots and hover previews.
- Switch between `Simple` and `Rendered`.
- Copy from an archived `PowerShell` or `properties` code block and verify the copied value excludes the language/header label.
- Click the popup download icon in `Manual` mode and confirm Chrome opens Save As with `chatgpt_extracted_conversation.txt`.
- Save the TXT and confirm turns are in original order with only `USER TURN` / `ASSISTANT TURN` labels and simple text content.
- Repeat the export smoke check in `Dynamic` mode.
- Cancel the Save As dialog and confirm no stale error loop or empty download appears.
- On an unsupported tab, click the export icon and confirm no empty TXT download starts and the icon briefly shows its error state.
- After an extension reload without reloading the ChatGPT tab, click export and confirm the popup reports that the ChatGPT tab needs reload instead of failing silently.

## Design Evolution

The project has evolved from a basic archive UI into a more structured conversation reader:

- **Initial virtualization focus** - older turns were detached or represented more cheaply so the newest ChatGPT context could remain live.
- **Manual and dynamic readers** - manual mode added explicit batch restore, while dynamic mode added slice-based navigation for larger histories.
- **Structured code block snapshots** - code block archiving now separates the UI/header label from the actual copyable code body, preventing labels such as `PowerShell` from being copied into commands.
- **Readable turn grouping** - adjacent `user -> assistant` records now use consistent bridge UI in both manual and dynamic readers so related turns scan as a pair.

These changes keep the implementation centered on browser-side archive quality rather than adding external infrastructure.

## Current Limitations

- The detector depends on ChatGPT's current page structure, so major ChatGPT DOM changes may require updates.
- The project is currently packaged only as a Chrome Manifest V3 extension.
- There is no automated browser end-to-end regression suite in the repository.
- Rich snapshot rendering intentionally omits or replaces heavy media such as images, canvases, videos, iframes, and SVGs for performance.
- Most settings are internal constants; the popup currently exposes only enable/disable and reader mode selection.

## License

This project is licensed under the MIT License. See [LICENSE](LICENSE).
