# Rapid View for ChatGPT

Rapid View for ChatGPT is a Chrome extension that keeps long ChatGPT conversations responsive by locally archiving older turns and leaving only a smaller live tail in the active DOM. It targets `chatgpt.com` and `chat.openai.com`, runs entirely in the browser, and focuses on page-side performance rather than model-side response speed.

## Project Overview

Long ChatGPT threads become expensive for the browser to keep fully mounted, especially when a conversation contains large rich-text answers, code blocks, tables, or many historical turns. This project addresses that problem with a local virtualization layer:

- it detects the active ChatGPT conversation thread
- converts older turns into lighter archive records
- removes heavy live DOM for older content
- renders a controlled archive UI for reading and restoring older turns

The result is a lighter page for long-running conversations without losing access to the older content.

## Main Capabilities

- Local conversation virtualization for long ChatGPT threads
- Turn-aware archiving so grouped assistant output stays together
- `Manual` mode for batch-based restore of older turns
- `Dynamic` mode for slice-based archive reading with a timeline UI
- Per-record `Simple` and `Rendered` archive views
- Expandable simple previews with `Show full simple`
- Live popup status reporting: `Active`, `Ready`, `Searching`, `Unavailable`

## How It Works

The extension is built around a content-script pipeline that runs directly on the ChatGPT page.

1. **Conversation detection**
   - `DomDetector` locates the current ChatGPT thread and resolves individual message/turn items from the page structure.

2. **Record building**
   - `ArchiveEngine` and `VirtualizationEngine` turn detected message items into internal records with turn metadata, text snapshots, and rendered archive content.

3. **Activation decision**
   - The extension stays passive on short threads and activates archive mode only when the conversation is large enough.
   - Current built-in thresholds are based on both turn count and estimated content height.
   - The default activation thresholds are:
     - `18` detected turns, or
     - about `6500px` estimated content height

4. **Live-tail preservation**
   - By default, the newest `4` turns remain live in the page.
   - Older turns are detached from the heavy live DOM and replaced with archive UI.

5. **Archive reading**
   - In `Manual` mode, older turns can be restored in batches.
   - In `Dynamic` mode, the archive is rendered as a lighter sliced reader with timeline navigation.

This design keeps the most relevant part of the thread fully live while moving older content into a cheaper representation.

## Privacy and Data Handling

Rapid View for ChatGPT is designed as a local-only browser extension.

- The manifest requests only the `storage` permission.
- Host permissions are limited to ChatGPT pages:
  - `https://chatgpt.com/*`
  - `https://chat.openai.com/*`
- Archive state and settings are stored in `chrome.storage.local`.
- There is no backend service in this repository and no custom network pipeline for exporting conversation data.

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
|   |-- content/
|   |   `-- content-script.js
|   |-- popup/
|   |   |-- popup.html
|   |   |-- popup.css
|   |   `-- popup.js
|   `-- shared/
|       |-- constants.js
|       `-- settings.js
```

### Important files

- `manifest.json` - Chrome Manifest V3 entry point, permissions, popup registration, and content-script wiring
- `src/content/content-script.js` - main runtime: detection, archiving, archive UI, and dynamic mode
- `src/shared/constants.js` - default settings, thresholds, and shared status/message constants
- `src/shared/settings.js` - storage-backed settings loader/saver
- `src/popup/` - popup UI for enabling the extension and switching between `Manual` and `Dynamic`

## Setup

There is no build step in the current repository. The extension can be loaded directly as an unpacked Chrome extension.

### Install as an unpacked extension

1. Download or clone this repository.
2. Open `chrome://extensions`.
3. Enable **Developer mode**.
4. Click **Load unpacked**.
5. Select the project root:
   - `D:\Python\my_side_projects\chrome_chatgpt_speed_booster`

## Usage

1. Open a ChatGPT conversation on `chatgpt.com` or `chat.openai.com`.
2. Open the extension popup.
3. Keep the extension enabled and choose one of the two reader modes:
   - `Manual`
   - `Dynamic`
4. As the conversation grows, the status will move through the runtime states:
   - `Searching` - the page is still being detected
   - `Ready` - the extension is attached but archive mode is not currently active
   - `Active` - older turns are being archived for performance
5. When archive mode is active:
   - use `Load 4 older` to restore older records in `Manual` mode
   - switch archived records between `Simple` and `Rendered`
   - use `Show full simple` for long simple previews
   - use the dynamic timeline controls when `Dynamic` mode is enabled

### What the modes mean

- **Manual**
  - keeps an explicit archive boundary
  - older content is restored in batches
  - better when you want predictable control over what comes back into the live thread

- **Dynamic**
  - keeps archive content in a lighter sliced reader
  - emphasizes scrolling/navigation through archived content instead of bulk restore
  - better for very large archived histories

### Archive view types

- **Simple**
  - lightweight plain-text oriented archive rendering
  - useful when performance and fast scanning matter most

- **Rendered**
  - richer archive rendering intended to preserve more of the original ChatGPT formatting
  - useful for code, layout, and richer content review

## Validation

The current codebase is validated primarily through:

- focused syntax checks such as `node --check`
- targeted manual verification on real ChatGPT threads

There is not currently a full automated browser end-to-end test suite in the repository.

## Design Notes

This project is more about custom page virtualization and DOM management than about integrating a broad stack of third-party services. The core engineering value is in the browser-side design:

- message/turn detection on a changing ChatGPT DOM
- turn-aware archive grouping
- local snapshot generation for archived content
- dual archive reading modes
- runtime activation based on thread size rather than a fixed always-on behavior

## Current Limitations

- The extension depends on ChatGPT's page structure, so major DOM changes on the site can require detector updates.
- It is currently packaged as a Chrome Manifest V3 extension; no separate Firefox or Edge packaging flow is included.
- There is not currently a full automated browser regression suite.
- Archive rendering for very rich content is an active engineering area.

## License

This project is licensed under the MIT License. See [LICENSE](LICENSE).
