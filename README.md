# openclaw-plugin-discord-voice-transcribe

Discord voice-note transcription plugin for OpenClaw.

For implementation details and operational behavior, see [`docs/TECHNICAL.md`](./docs/TECHNICAL.md).

## What it does

- Detects Discord voice-note attachments (`.ogg` / `.opus`)
- Downloads and converts audio with `ffmpeg`
- Transcribes locally with `whisper-cli`
- Replies with a text transcript
- Optionally forwards the transcript into the agent for AI follow-up
- Supports runtime/channel control with `/voice_transcribe`

## Installation

### 1) Put the plugin in your OpenClaw extensions directory

For example:

```bash
mkdir -p ~/.openclaw/extensions
git clone https://github.com/pancodia-lab/openclaw-plugin-discord-voice-transcribe \
  ~/.openclaw/extensions/discord-voice-transcribe
```

Or copy the repo contents into:

```bash
~/.openclaw/extensions/discord-voice-transcribe
```

### 2) Make sure required binaries are installed

The plugin expects these commands to be available on the host:

- `ffmpeg`
- `whisper-cli`

### 3) Enable the plugin in `openclaw.json`

Typical config lives under:

```json
plugins.entries.discord-voice-transcribe
```

Example:

```json
{
  "enabled": true,
  "config": {
    "mode": "selected-channels",
    "enabledChannelIds": ["123456789012345678"],
    "ffmpegBin": "ffmpeg",
    "whisperBin": "whisper-cli",
    "whisperModel": "/absolute/path/to/ggml-base.bin",
    "whisperLang": "auto",
    "respondWithAI": true,
    "respondPrefix": "User sent a voice note saying:"
  }
}
```

### 4) Restart OpenClaw / gateway

After installing or changing plugin config, restart your OpenClaw service so the plugin reloads.

## Commands

- `/voice_transcribe status`
- `/voice_transcribe on`
- `/voice_transcribe off`
- `/voice_transcribe mode all`
- `/voice_transcribe mode selected`
- `/voice_transcribe mode off`

## Configuration notes

1. **Use `mode` as the primary runtime state.**
   - `off` → loaded but inactive
   - `all` → enabled for all Discord channels
   - `selected-channels` → enabled only for `enabledChannelIds`

2. **`config.enabled` is deprecated as the primary runtime switch.**
   - It is still supported for backward compatibility.
   - For new setups, prefer `mode`.

3. **Set `whisperModel` explicitly when possible.**
   - Runtime fallback discovery exists, but an explicit path is more predictable.

4. If a channel or runtime mode is turned off while a job is already in flight, the plugin re-checks state before posting transcript / AI output and suppresses late output.

## Repository contents

- `index.mjs` — plugin implementation
- `openclaw.plugin.json` — plugin manifest and config schema
- `docs/TECHNICAL.md` — detailed technical documentation
