import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

let queue = Promise.resolve();

// Track voice note message IDs so we can suppress the normal agent pipeline.
// When respondWithAI is true, the plugin dispatches the transcript to the agent directly,
// so the normal pipeline processing the .ogg attachment would be a duplicate.
const voiceNoteMessageIds = new Set();

// Dedupe guard: avoid transcribing/sending twice for the same Discord message id
// (e.g., in case of repeated hook delivery or plugin reload quirks).
const processed = new Map();

const PERSISTED_CONFIG_KEYS = [
  "enabled",
  "mode",
  "enabledChannelIds",
  "ffmpegBin",
  "whisperBin",
  "whisperModel",
  "whisperLang",
  "whisperThreads",
  "whisperTimeoutMs",
  "ffmpegTimeoutMs",
  "maxAudioBytes",
  "transcriptPrefix",
  "maxReplyChars",
  "debug",
  "respondWithAI",
  "respondPrefix"
];

function dedupeTtlMs(cfg) {
  return Number.isFinite(cfg?.dedupeTtlMs) ? cfg.dedupeTtlMs : 6 * 60 * 60 * 1000; // 6h
}

function alreadyProcessed(cfg, mid) {
  const now = Date.now();
  const ttl = dedupeTtlMs(cfg);
  for (const [k, ts] of processed) {
    if (now - ts > ttl) processed.delete(k);
  }
  const ts = processed.get(mid);
  return typeof ts === "number" && now - ts <= ttl;
}

function markProcessed(mid) {
  processed.set(mid, Date.now());
}

async function appendDebugFile(p, line) {
  try {
    await fs.appendFile(p, line + "\n", "utf-8");
  } catch {
    // ignore
  }
}

function normalizeString(x) {
  return typeof x === "string" ? x.trim() : "";
}

function contentTypeIsAudio(ct) {
  const v = normalizeString(ct).toLowerCase();
  return v === "audio" || v.startsWith("audio/") || v.includes("opus");
}

function isVoiceAttachment(att) {
  const name = normalizeString(att?.filename ?? att?.name).toLowerCase();
  const ct = normalizeString(att?.content_type ?? att?.contentType).toLowerCase();
  return (
    name.endsWith(".ogg") ||
    name.endsWith(".opus") ||
    contentTypeIsAudio(ct) ||
    ct.includes("application/ogg")
  );
}

function resolveDiscordToken(openclawConfig, accountId) {
  const discord = openclawConfig?.channels?.discord;
  if (!discord) return null;
  const acctId = normalizeString(accountId) || "default";
  const token = discord?.accounts?.[acctId]?.token ?? discord?.token;
  return normalizeString(token) || null;
}

function stripChannelPrefix(id) {
  const s = normalizeString(id);
  if (!s) return "";
  return s.replace(/^(channel:|user:|guild:)/i, "");
}

function normalizeChannelId(id) {
  return stripChannelPrefix(id);
}

function normalizeChannelIdList(values) {
  if (!Array.isArray(values)) return [];
  const out = [];
  const seen = new Set();
  for (const value of values) {
    const id = normalizeChannelId(value);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function resolveChannelScopeMode(cfg) {
  const raw = normalizeString(cfg?.mode || "").toLowerCase();
  if (raw === "off") return "off";
  if (raw === "selected-channels") return "selected-channels";
  if (raw === "all") return "all";

  // Backward compatibility: older configs used config.enabled as a runtime switch.
  if (cfg?.enabled === false) return "off";
  return "all";
}

function resolveEventChannelId(event, ctx) {
  const rawTo = normalizeString(event?.metadata?.to);
  const metaChannelId = normalizeString(event?.metadata?.channelId);
  const conversationId = normalizeString(ctx?.conversationId);
  const ctxChannelId = normalizeString(ctx?.channelId);
  return normalizeChannelId(rawTo || metaChannelId || conversationId || ctxChannelId);
}

function shouldProcessMessageForChannel({ cfg, event, ctx }) {
  const mode = resolveChannelScopeMode(cfg);
  if (mode === "off") return false;
  if (mode === "all") return true;
  const channelId = resolveEventChannelId(event, ctx);
  if (!channelId) return false;
  const allowed = normalizeChannelIdList(cfg?.enabledChannelIds);
  return allowed.includes(channelId);
}

function getChannelStateSummary({ cfg, channelId }) {
  const mode = resolveChannelScopeMode(cfg);
  const globalEnabled = mode !== "off";
  const normalizedChannelId = normalizeChannelId(channelId);
  const enabledChannels = normalizeChannelIdList(cfg?.enabledChannelIds);
  const enabledHere = globalEnabled && (mode === "all" || (normalizedChannelId ? enabledChannels.includes(normalizedChannelId) : false));
  return {
    globalEnabled,
    mode,
    channelId: normalizedChannelId,
    enabledChannels,
    enabledHere
  };
}

function shouldEmitForChannel(cfg, channelId) {
  return getChannelStateSummary({ cfg, channelId }).enabledHere;
}

function clonePersistedPluginConfig(cfg) {
  const out = {};
  for (const key of PERSISTED_CONFIG_KEYS) {
    if (!(key in (cfg ?? {}))) continue;
    const value = cfg[key];
    if (Array.isArray(value)) out[key] = [...value];
    else if (value && typeof value === "object") out[key] = JSON.parse(JSON.stringify(value));
    else out[key] = value;
  }
  out.mode = resolveChannelScopeMode(cfg);
  out.enabled = out.mode !== "off";
  out.enabledChannelIds = normalizeChannelIdList(cfg?.enabledChannelIds);
  return out;
}

function findMatchingBrace(text, openIndex) {
  let depth = 0;
  let inString = false;
  let quote = "";
  let escape = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = openIndex; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];

    if (inLineComment) {
      if (ch === "\n") inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (ch === "*" && next === "/") {
        inBlockComment = false;
        i++;
      }
      continue;
    }
    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === "\\") {
        escape = true;
        continue;
      }
      if (ch === quote) {
        inString = false;
        quote = "";
      }
      continue;
    }
    if (ch === "/" && next === "/") {
      inLineComment = true;
      i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      inBlockComment = true;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      quote = ch;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function findPropertyObjectRange(objectText, propertyName) {
  const keyIndex = objectText.indexOf(`"${propertyName}"`);
  if (keyIndex === -1) return null;
  const colonIndex = objectText.indexOf(":", keyIndex);
  if (colonIndex === -1) return null;
  const openIndex = objectText.indexOf("{", colonIndex);
  if (openIndex === -1) return null;
  const closeIndex = findMatchingBrace(objectText, openIndex);
  if (closeIndex === -1) return null;
  return { start: openIndex, end: closeIndex + 1 };
}

function resolveOpenClawConfigPath(api) {
  const direct = normalizeString(api?.resolvePath?.("~/.openclaw/openclaw.json"));
  if (direct) return direct;

  const stateHome = normalizeString(api?.runtime?.state?.resolveHomeDir?.());
  if (stateHome) return path.join(stateHome, "openclaw.json");

  return path.join(os.homedir(), ".openclaw", "openclaw.json");
}

function resolveDefaultWhisperModelPath(api) {
  const configuredWorkspace = normalizeString(api?.resolvePath?.("~/.openclaw/workspace"));
  if (configuredWorkspace) {
    return path.join(configuredWorkspace, "tools", "whisper.cpp", "models", "ggml-base.bin");
  }

  const stateHome = normalizeString(api?.runtime?.state?.resolveHomeDir?.());
  if (stateHome) {
    return path.join(stateHome, "workspace", "tools", "whisper.cpp", "models", "ggml-base.bin");
  }

  return path.join(os.homedir(), ".openclaw", "workspace", "tools", "whisper.cpp", "models", "ggml-base.bin");
}

async function persistPluginConfig(api, cfg) {
  const configPath = resolveOpenClawConfigPath(api);
  const fileText = await fs.readFile(configPath, "utf-8");
  const pluginKey = '"discord-voice-transcribe"';
  const pluginKeyIndex = fileText.indexOf(pluginKey);
  if (pluginKeyIndex === -1) throw new Error("Plugin entry discord-voice-transcribe not found in openclaw.json");

  const pluginEntryOpenIndex = fileText.indexOf("{", pluginKeyIndex);
  if (pluginEntryOpenIndex === -1) throw new Error("Plugin entry object start not found in openclaw.json");
  const pluginEntryCloseIndex = findMatchingBrace(fileText, pluginEntryOpenIndex);
  if (pluginEntryCloseIndex === -1) throw new Error("Plugin entry object end not found in openclaw.json");

  const pluginEntryText = fileText.slice(pluginEntryOpenIndex, pluginEntryCloseIndex + 1);
  const configRange = findPropertyObjectRange(pluginEntryText, "config");
  if (!configRange) throw new Error("Plugin config object not found in openclaw.json");

  const persistable = clonePersistedPluginConfig(cfg);
  const replacement = JSON.stringify(persistable, null, 10);
  const updatedPluginEntryText =
    pluginEntryText.slice(0, configRange.start) +
    replacement +
    pluginEntryText.slice(configRange.end);

  const updatedFileText =
    fileText.slice(0, pluginEntryOpenIndex) +
    updatedPluginEntryText +
    fileText.slice(pluginEntryCloseIndex + 1);

  if (updatedFileText !== fileText) {
    await fs.writeFile(configPath, updatedFileText, "utf-8");
  }
}

function setChannelEnabled(cfg, channelId, enabled) {
  const id = normalizeChannelId(channelId);
  if (!id) throw new Error("Missing channel id");

  cfg.enabled = true; // backward-compatible mirror for older configs
  cfg.mode = "selected-channels";
  const next = normalizeChannelIdList(cfg.enabledChannelIds);
  const set = new Set(next);
  if (enabled) set.add(id);
  else set.delete(id);
  cfg.enabledChannelIds = [...set];
}

function formatStatusText(cfg, channelId) {
  const state = getChannelStateSummary({ cfg, channelId });
  const modeLabel = state.mode === "all"
    ? "all channels"
    : state.mode === "selected-channels"
      ? "selected channels only"
      : "off";
  const lines = [
    `Voice transcription is ${state.globalEnabled ? "globally enabled" : "globally disabled"}.`,
    `Mode: ${modeLabel}.`
  ];
  if (state.channelId) {
    lines.push(`This channel (${state.channelId}) is ${state.enabledHere ? "enabled" : "disabled"}.`);
  }
  if (state.mode === "selected-channels") {
    lines.push(
      state.enabledChannels.length
        ? `Enabled channels: ${state.enabledChannels.join(", ")}`
        : "Enabled channels: none"
    );
  }
  return lines.join("\n");
}

async function handleVoiceTranscribeCommand(api, cfg, ctx) {
  try {
    if ((ctx.channel || "").toLowerCase() !== "discord") {
      return { text: "This command is only available on Discord." };
    }

    const rawArgs = normalizeString(ctx.args).toLowerCase();
    const channelId = normalizeChannelId(ctx.channelId || ctx.to);
    const tokens = rawArgs ? rawArgs.split(/\s+/).filter(Boolean) : [];
    const [action] = tokens;

    if (!channelId) {
      return { text: "Could not determine the current Discord channel id." };
    }

    if (!action || action === "status") {
      return { text: formatStatusText(cfg, channelId) };
    }

    if (action === "on" || action === "enable") {
      setChannelEnabled(cfg, channelId, true);
      await persistPluginConfig(api, cfg);
      return {
        text:
          `Voice transcription enabled for this channel (${channelId}).\n` +
          formatStatusText(cfg, channelId)
      };
    }

    if (action === "off" || action === "disable") {
      cfg.enabled = false; // backward-compatible mirror for older configs
      cfg.mode = "off";
      await persistPluginConfig(api, cfg);
      return {
        text:
          `Voice transcription turned off.\n` +
          formatStatusText(cfg, channelId)
      };
    }

    if (action === "mode") {
      const modeArg = normalizeString(tokens[1]).toLowerCase();
      if (modeArg === "all") {
        cfg.enabled = true;
        cfg.mode = "all";
        await persistPluginConfig(api, cfg);
        return { text: `Voice transcription mode set to all channels.\n${formatStatusText(cfg, channelId)}` };
      }
      if (modeArg === "selected" || modeArg === "selected-channels") {
        cfg.enabled = true;
        cfg.mode = "selected-channels";
        cfg.enabledChannelIds = normalizeChannelIdList(cfg.enabledChannelIds);
        await persistPluginConfig(api, cfg);
        return { text: `Voice transcription mode set to selected channels only.\n${formatStatusText(cfg, channelId)}` };
      }
      if (modeArg === "off") {
        cfg.enabled = false;
        cfg.mode = "off";
        await persistPluginConfig(api, cfg);
        return { text: `Voice transcription mode set to off.\n${formatStatusText(cfg, channelId)}` };
      }
      return { text: 'Usage: /voice_transcribe mode all | /voice_transcribe mode selected | /voice_transcribe mode off' };
    }

    return {
      text:
        "Usage:\n" +
        "/voice_transcribe status\n" +
        "/voice_transcribe on\n" +
        "/voice_transcribe off\n" +
        "/voice_transcribe mode all\n" +
        "/voice_transcribe mode selected\n" +
        "/voice_transcribe mode off"
    };
  } catch (err) {
    const msg = String(err?.stack ?? err?.message ?? err);
    try {
      api.logger.error(`[discord-voice-transcribe] command failed: ${msg}`);
      await appendDebugFile("/tmp/discord-voice-transcribe.command", `${new Date().toISOString()} ${msg}`);
    } catch {}
    return { text: `Voice transcription command failed: ${String(err?.message ?? err)}` };
  }
}

async function fetchDiscordMessage({ token, channelId, messageId, timeoutMs = 10000, debug = false, api = null }) {
  const cid = stripChannelPrefix(channelId);
  const mid = stripChannelPrefix(messageId);
  const url = `https://discord.com/api/v10/channels/${cid}/messages/${mid}`;

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    if (debug && api) api.logger.info(`[discord-voice-transcribe] REST GET ${url} (timeoutMs=${timeoutMs})`);
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        Authorization: `Bot ${token}`
      }
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Discord fetch message failed: ${res.status} ${res.statusText}${body ? ` :: ${body}` : ""}`);
    }
    return res.json();
  } catch (err) {
    if (String(err?.name || "").toLowerCase().includes("abort")) {
      throw new Error(`Discord fetch message failed: timeout after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(t);
  }
}

async function transcribeOne({ api, cfg, audioUrl, fileLabel }) {
  const maxBytes = Number.isFinite(cfg.maxAudioBytes) ? cfg.maxAudioBytes : 8 * 1024 * 1024;
  const fetched = await api.runtime.channel.media.fetchRemoteMedia({
    url: audioUrl,
    maxBytes
  });

  const stateRoot = api.runtime.state.resolveStateDir();
  const tmpDir = path.join(stateRoot, "media", "discord-voice-transcribe");
  await fs.mkdir(tmpDir, { recursive: true });

  const base = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const oggPath = path.join(tmpDir, `${base}.ogg`);
  const wavPath = path.join(tmpDir, `${base}.wav`);

  try {
    await fs.writeFile(oggPath, fetched.buffer);

    const ffmpegBin = normalizeString(cfg.ffmpegBin) || "ffmpeg";
    const ffmpegTimeoutMs = Number.isFinite(cfg.ffmpegTimeoutMs) ? cfg.ffmpegTimeoutMs : 30000;

    const ff = await api.runtime.system.runCommandWithTimeout(
      [
        ffmpegBin,
        "-hide_banner",
        "-y",
        "-i",
        oggPath,
        "-ar",
        "16000",
        "-ac",
        "1",
        "-c:a",
        "pcm_s16le",
        wavPath
      ],
      { timeoutMs: ffmpegTimeoutMs }
    );

    if (ff.code !== 0) {
      throw new Error(`ffmpeg failed (code ${ff.code}): ${ff.stderr || ff.stdout || ""}`.trim());
    }

    const whisperBin = normalizeString(cfg.whisperBin) || "whisper-cli";
    const model = normalizeString(cfg.whisperModel) || resolveDefaultWhisperModelPath(api);
    const lang = normalizeString(cfg.whisperLang) || "auto";
    const threads = Number.isFinite(cfg.whisperThreads) ? String(cfg.whisperThreads) : "4";
    const whisperTimeoutMs = Number.isFinite(cfg.whisperTimeoutMs) ? cfg.whisperTimeoutMs : 180000;

    const w = await api.runtime.system.runCommandWithTimeout(
      [
        whisperBin,
        "-m",
        model,
        "-l",
        lang,
        "-t",
        threads,
        "-nt",
        wavPath
      ],
      { timeoutMs: whisperTimeoutMs }
    );

    if (w.code !== 0) {
      throw new Error(`whisper-cli failed (code ${w.code}): ${w.stderr || w.stdout || ""}`.trim());
    }

    const text = String(w.stdout || "").replace(/^\s+/g, "").trim();
    if (!text) return { ok: true, text: "(no speech detected)", fileLabel };
    return { ok: true, text, fileLabel };
  } finally {
    await fs.rm(oggPath, { force: true }).catch(() => {});
    await fs.rm(wavPath, { force: true }).catch(() => {});
  }
}

async function handleDiscordInbound({ api, cfg, event, ctx }) {
  const respondWithAI = cfg.respondWithAI === true;
  const respondPrefix = normalizeString(cfg.respondPrefix);

  const token = resolveDiscordToken(api.config, ctx.accountId);
  if (!token) return;

  if (cfg.debug === true) {
    const meta = event?.metadata ?? {};
    api.logger.info(
      `[discord-voice-transcribe] message_received: channelId=${normalizeString(ctx?.channelId)} accountId=${normalizeString(ctx?.accountId)} conversationId=${normalizeString(ctx?.conversationId)} metaKeys=${Object.keys(meta).join(",")}`
    );
    api.logger.info(
      `[discord-voice-transcribe] meta: messageId=${normalizeString(meta.messageId)} to=${normalizeString(meta.to)} surface=${normalizeString(meta.surface)} threadId=${normalizeString(meta.threadId)} senderId=${normalizeString(meta.senderId)}`
    );
  }

  const messageId = normalizeString(event?.metadata?.messageId);
  const rawTo = normalizeString(event?.metadata?.to);
  const channelId = rawTo || normalizeString(ctx.conversationId);

  const cid = stripChannelPrefix(channelId);
  const mid = stripChannelPrefix(messageId);

  if (cfg.debug === true) {
    api.logger.info(`[discord-voice-transcribe] resolved ids: rawTo=${rawTo} channelId=${channelId} cid=${cid} messageId=${messageId} mid=${mid}`);
  }

  if (!mid || !cid) return;

  if (alreadyProcessed(cfg, mid)) {
    if (cfg.debug === true) api.logger.info(`[discord-voice-transcribe] dedupe: skip already-processed messageId=${mid}`);
    return;
  }
  markProcessed(mid);

  let msg;
  try {
    msg = await fetchDiscordMessage({ token, channelId: cid, messageId: mid, timeoutMs: Number.isFinite(cfg.restTimeoutMs) ? cfg.restTimeoutMs : 10000, debug: cfg.debug === true, api });
  } catch (err) {
    api.logger.error(`[discord-voice-transcribe] fetchDiscordMessage failed (channelId=${cid} messageId=${mid}): ${String(err?.message ?? err)}`);
    return;
  }
  const atts = Array.isArray(msg.attachments) ? msg.attachments : [];
  const voiceAtts = atts.filter(isVoiceAttachment);
  if (cfg.debug === true) {
    api.logger.info(`[discord-voice-transcribe] fetched message: attachments=${atts.length} voiceAtts=${voiceAtts.length}`);
  }
  if (!voiceAtts.length) return;

  if (respondWithAI) {
    voiceNoteMessageIds.add(mid);
    setTimeout(() => voiceNoteMessageIds.delete(mid), 10 * 60 * 1000);
  }

  const results = [];
  for (const att of voiceAtts) {
    const url = normalizeString(att.url);
    if (!url) continue;
    const label = normalizeString(att.filename) || normalizeString(att.id) || "audio";
    if (cfg.debug === true) api.logger.info(`[discord-voice-transcribe] transcribing: ${label} urlHost=${(() => { try { return new URL(url).host; } catch { return ""; } })()}`);
    try {
      results.push(await transcribeOne({ api, cfg, audioUrl: url, fileLabel: label }));
    } catch (err) {
      results.push({ ok: false, error: String(err?.message ?? err), fileLabel: label });
    }
  }

  if (!results.length) return;

  const prefix = normalizeString(cfg.transcriptPrefix) || "Transcript:";
  const maxReplyChars = Number.isFinite(cfg.maxReplyChars) ? cfg.maxReplyChars : 1900;

  const lines = results.map((r) => {
    if (r.ok) {
      const head = results.length > 1 ? `**${r.fileLabel}:** ` : "";
      return `${head}${r.text}`;
    }
    const head = results.length > 1 ? `**${r.fileLabel}:** ` : "";
    return `${head}(error) ${r.error}`;
  });

  let body = `${prefix} ${lines.join("\n\n")}`;
  if (body.length > maxReplyChars) body = body.slice(0, maxReplyChars - 1) + "…";

  const replyToId = rawTo || channelId || `channel:${cid}`;

  if (!shouldEmitForChannel(cfg, cid)) {
    if (cfg.debug === true) {
      api.logger.info(`[discord-voice-transcribe] drop transcript output after re-check: channel disabled cid=${cid} mid=${mid}`);
    }
    return;
  }

  if (cfg.debug === true) api.logger.info(`[discord-voice-transcribe] sending transcript reply to=${replyToId} replyTo=${mid}`);

  try {
    await api.runtime.channel.discord.sendMessageDiscord(replyToId, body, {
      token,
      replyTo: mid
    });
  } catch (err) {
    api.logger.error(`[discord-voice-transcribe] sendMessageDiscord failed: ${String(err?.message ?? err)}`);
  }

  if (respondWithAI) {
    try {
      if (!shouldEmitForChannel(cfg, cid)) {
        if (cfg.debug === true) {
          api.logger.info(`[discord-voice-transcribe] drop AI follow-up after re-check: channel disabled cid=${cid} mid=${mid}`);
        }
        return;
      }

      await appendDebugFile("/tmp/discord-voice-transcribe.ai", `${new Date().toISOString()} start cid=${cid} mid=${mid}`);

      const route = api.runtime.channel.routing.resolveAgentRoute({
        cfg: api.config,
        channel: "discord",
        accountId: ctx?.accountId ?? null,
        peer: { kind: "channel", id: cid },
        parentPeer: null,
        guildId: normalizeString(event?.metadata?.guildId) || normalizeString(ctx?.guildId) || null,
        teamId: null
      });

      const promptText = respondPrefix ? `${respondPrefix}\n\n${lines.join("\n\n")}` : lines.join("\n\n");

      const baseCtx = {
        Body: promptText,
        RawBody: promptText,
        CommandBody: promptText,
        BodyForCommands: promptText,
        WasMentioned: true,
        ChatType: "group",
        From: normalizeString(event?.from) || "discord:user",
        To: replyToId,
        AccountId: ctx?.accountId ?? "default",
        Provider: "discord",
        Surface: "discord",
        OriginatingChannel: "discord",
        OriginatingTo: replyToId,
        SessionKey: route.sessionKey,
        ConversationLabel: normalizeString(ctx?.conversationId) || "discord",
        ReplyToId: mid,
        Timestamp: Date.now()
      };

      const finalized = api.runtime.channel.reply.finalizeInboundContext(baseCtx);

      const { dispatcher, replyOptions } = api.runtime.channel.reply.createReplyDispatcherWithTyping({
        deliver: async (payload, info) => {
          const text = normalizeString(payload?.text);
          if (!text) return;
          const replyTo = normalizeString(payload?.replyToId) || mid;
          await api.runtime.channel.discord.sendMessageDiscord(replyToId, text, {
            token,
            replyTo
          });
        },
        onError: (err, info) => {
          api.logger.error(`[discord-voice-transcribe] agent deliver error (${info?.kind ?? "?"}): ${String(err?.message ?? err)}`);
        }
      });

      const result = await api.runtime.channel.reply.dispatchReplyFromConfig({
        ctx: finalized,
        cfg: api.config,
        dispatcher,
        replyOptions
      });

      await dispatcher.waitForIdle();
      await appendDebugFile("/tmp/discord-voice-transcribe.ai", `${new Date().toISOString()} done cid=${cid} mid=${mid} queuedFinal=${result?.queuedFinal} counts=${JSON.stringify(result?.counts ?? {})}`);
    } catch (err) {
      await appendDebugFile("/tmp/discord-voice-transcribe.ai", `${new Date().toISOString()} ERROR cid=${cid} mid=${mid} err=${String(err?.stack ?? err?.message ?? err)}`);
      api.logger.error(`[discord-voice-transcribe] respondWithAI failed: ${String(err?.message ?? err)}`);
    }
  }
}

export default function discordVoiceTranscribePlugin(api) {
  const cfg = api.pluginConfig ?? {};
  if (!Array.isArray(cfg.enabledChannelIds)) cfg.enabledChannelIds = [];
  cfg.enabledChannelIds = normalizeChannelIdList(cfg.enabledChannelIds);
  cfg.mode = resolveChannelScopeMode(cfg);

  try {
    api.logger.info("[discord-voice-transcribe] LOADED");
  } catch {}
  queue = queue.then(async () => {
    await appendDebugFile("/tmp/discord-voice-transcribe.loaded", `${new Date().toISOString()} loaded`);
  });

  api.registerCommand({
    name: "voice_transcribe",
    description: "Manage Discord voice transcription for this channel.",
    acceptsArgs: true,
    nativeNames: {
      discord: "voice_transcribe"
    },
    handler: async (ctx) => handleVoiceTranscribeCommand(api, cfg, ctx)
  });

  api.on("before_agent_start", async (event, ctx) => {
    if (cfg.respondWithAI !== true) return {};
    const prompt = event?.prompt ?? "";
    const hasOggAttachment = /\.(ogg|opus)\b/i.test(prompt) && /audio/i.test(prompt);
    if (!hasOggAttachment) return {};

    if (cfg.debug === true) {
      api.logger.info(`[discord-voice-transcribe] before_agent_start: suppressing agent for voice note (prompt contains .ogg audio reference)`);
    }
    return {
      prependContext: "[SYSTEM INSTRUCTION FROM VOICE TRANSCRIBE PLUGIN]: This message contains a voice note audio attachment (.ogg). The discord-voice-transcribe plugin is already handling transcription and AI response for this voice note. Do NOT process or respond to this audio attachment. Reply with ONLY: NO_REPLY"
    };
  });

  api.on("message_received", async (event, ctx) => {
    const ch = normalizeString(ctx?.channelId).toLowerCase();

    await appendDebugFile(
      "/tmp/discord-voice-transcribe.hit",
      `${new Date().toISOString()} channelId=${ch || "(empty)"} from=${normalizeString(event?.from)} hasMeta=${event?.metadata ? "yes" : "no"}`
    );

    if (!shouldProcessMessageForChannel({ cfg, event, ctx })) return;

    queue = queue
      .then(() => handleDiscordInbound({ api, cfg, event, ctx }))
      .catch((err) => api.logger.error(`[discord-voice-transcribe] ${String(err)}`));
  });
}
