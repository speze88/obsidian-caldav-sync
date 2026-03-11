# Obsidian CalDAV Task Sync

An [Obsidian](https://obsidian.md) plugin that bidirectionally synchronizes markdown tasks to/from a CalDAV server (e.g. mailcow/SOGo).

## Features

- Tag tasks with a configured calendar tag such as `#caldav`, `#work`, or `#private`
- Map multiple CalDAV calendars to different tags
- Syncs on file save — no background polling
- Bidirectional: push completions to the server, pull remote title/status changes back
- UIDs stored in invisible HTML comments so your notes stay readable
- Works with any CalDAV server that supports VTODO (mailcow, SOGo, Nextcloud, Baikal, etc.)

## Task Format

**Before sync** (you write this):
```
- [ ] Buy groceries #private
```

**After sync** (UID written back automatically):
```
- [ ] Buy groceries #private <!-- caldav-uid:550e8400-e29b-41d4-a716-446655440000 -->
```

The UID comment is invisible in Obsidian's reading/preview mode.

## Installation

### Manual

1. Download or build `main.js` and `manifest.json`
2. Create the plugin folder in your vault:
   ```
   <vault>/.obsidian/plugins/obsidian-caldav-sync/
   ```
3. Copy `main.js` and `manifest.json` into that folder
4. Enable the plugin in Obsidian → Settings → Community plugins

### Build from source

```bash
git clone https://github.com/your-username/obsidian-caldav-sync
cd obsidian-caldav-sync
npm install
npm run build
```

Then copy `main.js` and `manifest.json` to your vault's plugin folder as above.

## Configuration

Go to Settings → CalDAV Task Sync and fill in the shared credentials plus one or more calendar mappings:

| Field | Description | Example |
|---|---|---|
| Username | Your CalDAV username (usually your full email for mailcow) | `user@example.com` |
| Password | Your CalDAV password | |
| Calendar name | Optional label shown in settings | `Private` |
| Server URL | Full CalDAV calendar URL with trailing slash | `https://mail.example.com/SOGo/dav/user@example.com/Calendar/personal/` |
| Tag | Tag that routes a task into this calendar | `#private` |

Use `Add calendar` to create additional mappings. Username and password are shared across all configured calendars.

Example mappings:

| Tag | Calendar |
|---|---|
| `#private` | Personal CalDAV calendar |
| `#work` | Work CalDAV calendar |

Example task routing:

```text
- [ ] Pay rent #private
- [ ] Prepare Q2 review #work
```

Each task is synced to the calendar whose configured tag appears on the same task line.

### Finding your CalDAV URL (mailcow / SOGo)

Your calendar URL typically follows this pattern:
```
https://<mail-server>/SOGo/dav/<email>/Calendar/<calendar-name>/
```

You can verify it with curl:
```bash
curl -u user@example.com:password \
  https://mail.example.com/SOGo/dav/user@example.com/Calendar/personal/ \
  -X PROPFIND -H "Depth: 0"
```
A `207 Multi-Status` response confirms the URL and credentials are correct.

## Sync Behavior

Sync is triggered every time you save a markdown file.

### Conflict resolution

| Scenario | Result |
|---|---|
| Local `[x]`, remote incomplete | Local wins — pushes `STATUS:COMPLETED` |
| Local `[ ]`, remote completed | Remote wins — marks task `[x]` in your note |
| Local title differs from remote SUMMARY | Remote wins — updates the title in your note |
| Remote VTODO not found (404) | Warning logged, local task unchanged |
| ETag conflict (412) | Re-fetches ETag and retries the PUT once |

### Re-entrancy

When the plugin writes UIDs or pulled changes back to a file, it uses an internal guard to prevent that write from triggering another sync loop.

## Dependencies

- [`tsdav`](https://www.npmjs.com/package/tsdav) — CalDAV client
- [`uuid`](https://www.npmjs.com/package/uuid) — UID generation

## Limitations

- No periodic background sync — changes only sync on file save
- Remote-only tasks (created outside Obsidian) are not pulled into notes automatically
- No support for recurring tasks, due dates, or priorities (v1)
- Sync tag must appear on the same line as the task checkbox

## License

MIT
