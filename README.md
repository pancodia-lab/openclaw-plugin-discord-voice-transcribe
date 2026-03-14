# openclaw-plugin-discord-voice-transcribe

Discord voice-note transcription plugin for OpenClaw.

For implementation details and operational behavior, see [`docs/TECHNICAL.md`](./docs/TECHNICAL.md).

## Motivation

Discord voice notes are convenient for humans, but by default OpenClaw receives them as `.ogg` audio attachments rather than text. That means the agent cannot directly use the spoken content unless you add a transcription step.

This plugin solves that inside the existing OpenClaw message pipeline. Instead of introducing a separate companion bot or a second Discord connection, it hooks into `message_received`, transcribes the audio locally with `ffmpeg` + `whisper-cli`, and posts the result back into the same conversation.

It is especially useful when you want:

- a searchable text record of voice messages
- agent replies driven by spoken input
- per-channel control over where voice transcription is active
- local transcription with host-managed `ffmpeg` and `whisper-cli`
- a solution that reuses the existing OpenClaw Discord connection instead of adding another bot process

### Before / after

**Before**
- A user sends a Discord voice note.
- OpenClaw receives it as an `.ogg` attachment, not as usable text.
- The agent cannot "hear" the content directly.
- You would need a separate manual transcription step or an extra bot/service to bridge audio into text.

**After**
- A user sends a Discord voice note.
- The plugin intercepts the inbound message, fetches the attachment, and transcribes it locally.
- A transcript is posted back into the same Discord conversation.
- If `respondWithAI` is enabled, the transcript is also dispatched into OpenClaw so the agent can reply as if the user had typed the message.
- Runtime behavior can be controlled from Discord itself with `/voice_transcribe`, including per-channel enable/disable and explicit `mode` control.

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

After the plugin is loaded, use these commands in Discord to inspect or change runtime behavior for voice transcription:

- `/voice_transcribe status` — show current runtime mode and whether the current channel is enabled
- `/voice_transcribe on` — enable transcription for the current channel and switch runtime mode to `selected-channels`
- `/voice_transcribe off` — turn runtime behavior off
- `/voice_transcribe mode all` — enable transcription in all Discord channels
- `/voice_transcribe mode selected` — enable transcription only for channels listed in `enabledChannelIds`
- `/voice_transcribe mode off` — disable runtime behavior while keeping the plugin loaded

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
