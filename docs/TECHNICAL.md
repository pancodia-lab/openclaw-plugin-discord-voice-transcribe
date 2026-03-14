# Technical Documentation: `discord-voice-transcribe`

## Overview

`discord-voice-transcribe` is an OpenClaw plugin for Discord that:

1. detects Discord voice-note attachments (`.ogg`, `.opus`, audio content types)
2. downloads the attachment through OpenClaw media APIs
3. converts the audio to mono 16 kHz WAV with `ffmpeg`
4. transcribes it locally with `whisper-cli`
5. replies with a transcript in Discord
6. optionally forwards the transcript into the agent pipeline for AI follow-up

It also supports per-channel and runtime control through the plugin command:

- `/voice_transcribe status`
- `/voice_transcribe on`
- `/voice_transcribe off`
- `/voice_transcribe mode all`
- `/voice_transcribe mode selected`
- `/voice_transcribe mode off`

---

## Repository

Repo:

<https://github.com/pancodia-lab/openclaw-plugin-discord-voice-transcribe>

---

## Plugin manifest

File:

`openclaw.plugin.json`

### Manifest fields

- `id`: `discord-voice-transcribe`
- `name`: `Discord Voice Note Transcriber`
- `version`: `0.1.0`
- `channels`: `["discord"]`
- `hooks`: `["message_received", "before_agent_start"]`

### Config schema

The plugin config lives under:

`plugins.entries.discord-voice-transcribe.config`

Current schema fields:

1. `enabled: boolean`
   - deprecated as the primary runtime state switch
   - retained for backward compatibility and mirrored persistence
   - default: `true`

2. `mode: "off" | "all" | "selected-channels"`
   - primary runtime state machine
   - default: `all`

3. `enabledChannelIds: string[]`
   - channel allowlist used when `mode = "selected-channels"`
   - default: `[]`

4. `ffmpegBin: string`
   - executable name/path for ffmpeg
   - default: `ffmpeg`

5. `whisperBin: string`
   - executable name/path for whisper.cpp CLI
   - default: `whisper-cli`

6. `whisperModel: string`
   - explicit whisper model path
   - default: `""`
   - recommended to set explicitly in host config

7. `whisperLang: string`
   - language passed to whisper
   - default: `auto`

8. `whisperThreads: integer`
   - whisper thread count
   - default: `4`

9. `whisperTimeoutMs: integer`
   - max whisper runtime in ms
   - default: `180000`

10. `ffmpegTimeoutMs: integer`
    - max ffmpeg runtime in ms
    - default: `30000`

11. `maxAudioBytes: integer`
    - max downloaded audio size
    - default: `8388608` (8 MiB)

12. `transcriptPrefix: string`
    - prefix used for transcript reply
    - default: `Transcript:`

13. `maxReplyChars: integer`
    - max transcript message size
    - default: `1900`

14. `debug: boolean`
    - enables extra logging
    - default: `false`

15. `respondWithAI: boolean`
    - whether the transcript is also forwarded to the agent
    - default: `false`

16. `respondPrefix: string`
    - prefix added to transcript text before AI dispatch
    - default: `""`

### Runtime-state recommendation

Use this mental model:

1. `plugins.entries.discord-voice-transcribe.enabled`
   - loader switch at the OpenClaw plugin level
   - `false` means the plugin is not loaded at all

2. `plugins.entries.discord-voice-transcribe.config.mode`
   - runtime behavior switch inside the loaded plugin
   - `off` → loaded but inactive
   - `all` → active in all Discord channels
   - `selected-channels` → active only in `enabledChannelIds`

3. `plugins.entries.discord-voice-transcribe.config.enabled`
   - deprecated runtime switch
   - still honored for backward compatibility when `mode` is absent
   - persisted as a mirror of `mode` so older configs keep working

---

## Current host configuration

Current host config snippet in `~/.openclaw/openclaw.json`:

```json
"discord-voice-transcribe": {
  "enabled": true,
  "config": {
    "enabled": true,
    "mode": "selected-channels",
    "enabledChannelIds": [
      "123456789012345678"
    ],
    "ffmpegBin": "ffmpeg",
    "whisperBin": "whisper-cli",
    "whisperModel": "/absolute/path/to/ggml-base.bin",
    "whisperLang": "auto",
    "whisperThreads": 2,
    "whisperTimeoutMs": 180000,
    "ffmpegTimeoutMs": 30000,
    "maxAudioBytes": 8388608,
    "transcriptPrefix": "Transcript:",
    "maxReplyChars": 1900,
    "debug": true,
    "respondWithAI": true,
    "respondPrefix": "User sent a voice note saying:"
  }
}
```

### Interpretation of current host state

- plugin globally loaded
- runtime mode is selected-channel mode
- currently enabled channel list includes one configured Discord channel
- host uses explicit whisper model path
- AI follow-up is enabled
- debug logging is enabled

---

## Runtime architecture

Main implementation file:

`index.mjs`

### High-level runtime flow

1. plugin loads
2. plugin registers `/voice_transcribe` command
3. plugin listens on `message_received`
4. plugin filters by runtime mode + channel scope
5. plugin fetches the original Discord message via REST
6. plugin filters attachments to voice-note-like audio
7. plugin downloads the audio
8. plugin converts OGG/Opus to WAV using `ffmpeg`
9. plugin transcribes WAV using `whisper-cli`
10. plugin sends transcript reply
11. optionally plugin dispatches transcript into AI reply flow

### Hook usage

#### `message_received`
Used to intercept incoming Discord messages and trigger transcription flow.

#### `before_agent_start`
Used to suppress duplicate agent processing when `respondWithAI = true` and the original inbound message contains the voice note attachment. Without this, the plugin could reply once and the normal agent pipeline could also respond.

---

## Core internal behaviors

### 1) Voice-note detection

The plugin treats an attachment as a voice note if one of the following is true:

- filename ends with `.ogg`
- filename ends with `.opus`
- content type starts with `audio/`
- content type contains `opus`
- content type contains `application/ogg`

### 2) Queueing model

The plugin serializes work with a single promise queue:

```js
let queue = Promise.resolve();
```

This prevents multiple whisper jobs from starting in parallel uncontrollably.

### 3) Dedupe model

A process-local dedupe map tracks processed Discord message IDs to avoid duplicate transcription for the same message.

Default dedupe TTL:
- 6 hours

### 4) Runtime mode and channel scoping model

The plugin uses the following runtime model:

#### `mode = "off"`
- plugin stays loaded
- runtime message processing is disabled
- transcript / AI output should not be emitted

#### `mode = "all"`
- all Discord channels are enabled

#### `mode = "selected-channels"`
- only channels listed in `enabledChannelIds` are enabled

### 5) Backward compatibility behavior for `config.enabled`

The plugin still supports older configs that relied on:

```json
config.enabled = false
```

Behavior:
- if `mode` is absent and `config.enabled = false`, runtime is treated as `off`
- when the plugin persists new config, it mirrors:
  - `mode = off` → `enabled = false`
  - any other mode → `enabled = true`

This keeps older deployments working while moving the conceptual model to `mode`.

### 6) Output-time safety re-checks

To avoid late transcript replies after a channel has been disabled, the plugin re-checks channel state:

1. before sending transcript output
2. before dispatching AI follow-up

This means:
- a voice note can be accepted while a channel is enabled
- the channel or runtime mode can then be turned off
- if the job is still in flight, transcript / AI output is dropped instead of posted

This is important because it fixes the earlier race where already-running jobs could still emit output after disable.

---

## Command behavior

The plugin registers the command:

- native/text name: `voice_transcribe`

### Supported actions

#### `/voice_transcribe status`
Returns current state summary for the current channel:
- global enabled/disabled state
- current mode
- whether this channel is enabled
- enabled channel list when in selected-channel mode

#### `/voice_transcribe on`
- sets `enabled = true` as backward-compatible mirror
- sets `mode = "selected-channels"`
- adds current channel ID to `enabledChannelIds`
- persists updated config to `~/.openclaw/openclaw.json`

#### `/voice_transcribe off`
- sets `enabled = false` as backward-compatible mirror
- sets `mode = "off"`
- persists updated config to `~/.openclaw/openclaw.json`

#### `/voice_transcribe mode all`
- sets `enabled = true`
- sets `mode = "all"`
- persists config

#### `/voice_transcribe mode selected`
- sets `enabled = true`
- sets `mode = "selected-channels"`
- preserves normalized `enabledChannelIds`
- persists config

#### `/voice_transcribe mode off`
- sets `enabled = false`
- sets `mode = "off"`
- persists config

### Command persistence behavior

The plugin persists config by editing the plugin’s config object inside:

`~/.openclaw/openclaw.json`

Important details:
- it only persists a controlled subset of keys (`PERSISTED_CONFIG_KEYS`)
- it normalizes `mode`
- it normalizes and deduplicates `enabledChannelIds`
- it mirrors deprecated `config.enabled` based on `mode`

---

## Path resolution behavior

The plugin avoids hardcoded host-specific path fallbacks in repo code.

### OpenClaw config path resolution

Order:

1. `api.resolvePath("~/.openclaw/openclaw.json")`
2. `api.runtime.state.resolveHomeDir()` + `/openclaw.json`
3. `os.homedir() + "/.openclaw/openclaw.json"`

### Whisper model fallback resolution

Order:

1. explicit `cfg.whisperModel`
2. `api.resolvePath("~/.openclaw/workspace") + /tools/whisper.cpp/models/ggml-base.bin`
3. `api.runtime.state.resolveHomeDir() + /workspace/tools/whisper.cpp/models/ggml-base.bin`
4. `os.homedir() + "/.openclaw/workspace/tools/whisper.cpp/models/ggml-base.bin"`

### Recommendation

Even though runtime fallback exists, production setups should set:

- `whisperModel`
- `ffmpegBin`
- `whisperBin`

explicitly in config.

---

## Logging and debug artifacts

### Normal logging

The plugin logs a startup message:
- `[discord-voice-transcribe] LOADED`

This was changed from error severity to info severity to avoid misleading startup logs.

### Debug temp files

The plugin may append diagnostics to:

- `/tmp/discord-voice-transcribe.loaded`
- `/tmp/discord-voice-transcribe.hit`
- `/tmp/discord-voice-transcribe.ai`
- `/tmp/discord-voice-transcribe.command`

These are operational debug artifacts, not required for normal plugin behavior.

---

## Interaction with agent replies

When `respondWithAI = true`:

1. the plugin sends the transcript as a normal Discord reply
2. then it dispatches transcript text into OpenClaw’s reply pipeline
3. it marks the interaction as mentioned / group context so the agent is allowed to respond
4. `before_agent_start` suppression prevents the original voice-note attachment from being processed redundantly by the normal agent path

This prevents duplicate replies while still enabling a transcript-driven AI response.

---

## Operational gotchas

### 1) Runtime mode off vs plugin loader off
- `plugins.entries.discord-voice-transcribe.enabled = false` means the plugin is not loaded at all
- `plugins.entries.discord-voice-transcribe.config.mode = off` means the plugin is loaded but inactive

### 2) Explicit config is safer than fallback discovery
If `whisperModel` is missing and fallback discovery is wrong for a given host layout, transcription may fail.

### 3) Queue is serialized
Large or slow transcriptions can delay later voice notes because work is intentionally serialized.

### 4) Config persistence edits the main OpenClaw config file
This is intentional for command-driven state changes, but it means command execution depends on the plugin being able to resolve and write `~/.openclaw/openclaw.json`.

---

## Suggested future improvements

1. Add a dedicated `restTimeoutMs` field to schema if runtime tuning is needed.
2. Document example install steps for `ffmpeg` and `whisper-cli` in README.
3. Add a `channel status list` command output format for easier admin visibility.
4. Consider optional multi-worker transcription if throughput ever matters.
5. Consider safer structured config editing if OpenClaw exposes a first-class plugin config write API in the future.

---

## Summary

This plugin is currently a Discord-only OpenClaw extension that is production-usable for:

- voice-note transcription
- transcript replies
- optional AI follow-up
- per-channel enable/disable control
- explicit runtime off mode
- suppression of late transcript output after disable

The current host deployment is configured in selected-channel mode with explicit whisper model path and AI follow-up enabled.
