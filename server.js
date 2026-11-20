// Touchline: a voice/text driven tactics board.
// Plain Node (node:http), no dependencies. Serves public/index.html and
// POST /api/plan, which asks Claude for new positions through a tool call.

import { createServer } from "node:http"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

const HERE = dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.PORT ?? 3000)
const HOST = process.env.HOST ?? "0.0.0.0"
const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5"
// Effort trades thinking depth for speed; "low" keeps a reply well inside the
// 30 s timeout. Set ANTHROPIC_EFFORT=none for a model that takes no effort.
const EFFORT = process.env.ANTHROPIC_EFFORT || "low"
// Server-side refusal fallback (beta). ANTHROPIC_FALLBACKS=off to turn it off.
// The gateway forwards bodies untouched, but not every beta header, so the fallback is off there.
const FALLBACKS = process.env.ANTHROPIC_FALLBACKS !== "off" && !(process.env.TOKENS_URL && process.env.TOKENS_APP_KEY)
// Where Claude is asked. With TOKENS_URL and TOKENS_APP_KEY set, every call goes through the
// Token Center's gateway (Anthropic's Messages API, metered and charged to one shared user);
// otherwise straight to Anthropic with ANTHROPIC_API_KEY.
const TOKENS_URL = (process.env.TOKENS_URL || "").replace(/\/+$/, "")
const TOKENS_APP_KEY = process.env.TOKENS_APP_KEY || ""
const TOKENS_USER = process.env.TOKENS_USER || "pitch-public"
const VIA_TOKENS = Boolean(TOKENS_URL && TOKENS_APP_KEY)
const API_URL = VIA_TOKENS
  ? `${TOKENS_URL}/v1/messages`
  : `${(process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com").replace(/\/+$/, "")}/v1/messages`
// Web search through a PCP server (an MCP server) with Touchline's own token: Touchline runs the
// search itself, as a client tool, because the Token Center does not price Anthropic's
// server-side search. PCP_SEARCH names the PCP tool as "server/tool"; PCP_SEARCH_ARG is the
// name of its query argument. Without PCP, direct mode keeps Anthropic's own web search and
// Token Center mode has none.
const PCP_URL = process.env.PCP_URL || ""
const PCP_TOKEN = process.env.PCP_TOKEN || ""
const PCP_SEARCH = process.env.PCP_SEARCH || ""
const PCP_SEARCH_ARG = process.env.PCP_SEARCH_ARG || "query"
const PCP_RUN_TOOL = process.env.PCP_RUN_TOOL || "run_read"
const PCP_ON = Boolean(PCP_URL && PCP_TOKEN && /^[^/]+\/[^/]+$/.test(PCP_SEARCH))
const TIMEOUT_MS = 60_000 // one request to Claude
const TOTAL_MS = 110_000 // the whole answer, searches included
const MAX_SEARCHES = Number(process.env.MAX_SEARCHES ?? 3)
const MAX_BODY = 64 * 1024
const RATE_LIMIT = Number(process.env.RATE_LIMIT_PER_MINUTE ?? 12)
const RATE_WINDOW_MS = 60_000

const PITCH = { length: 105, width: 68 }

// ---------------------------------------------------------------- the tool

const point = {
  type: "object",
  properties: {
    x: { type: "number", description: "Metres from the home goal line (0) to the away goal line (pitch length)" },
    y: { type: "number", description: "Metres from the top touchline (0) to the bottom touchline (pitch width)" },
  },
  required: ["x", "y"],
  additionalProperties: false,
}

const SET_FORMATION = {
  name: "set_formation",
  description:
    "Set the pitch and place every player and the ball after the coach's instruction. " +
    "Return every player who should be on the pitch, including the ones that do not move; a player left out is taken off.",
  strict: true,
  input_schema: {
    type: "object",
    properties: {
      pitch: {
        type: "object",
        description: "Pitch size in metres. Keep the current size unless the instruction changes the format (youth football, small-sided games, futsal).",
        properties: {
          length: { type: "number", description: "Goal line to goal line, 20 to 120" },
          width: { type: "number", description: "Touchline to touchline, 15 to 90" },
        },
        required: ["length", "width"],
        additionalProperties: false,
      },
      players: {
        type: "array",
        description: "Every player on the pitch, both teams, 0 to 11 each (a drill may use only a few). Ids H1..Hn (home) and A1..An (away), numbered from 1 with no gaps.",
        items: {
          type: "object",
          properties: {
            id: { type: "string", description: "H1..H11 for home, A1..A11 for away" },
            team: { type: "string", enum: ["home", "away"] },
            shirt: { type: "integer", description: "Shirt number shown on the disc" },
            role: { type: "string", description: "Short position label, at most 3 letters: GK, CB, LB, RB, DM, CM, AM, LW, RW, ST, LM, RM, LWB, RWB" },
            x: { type: "number" },
            y: { type: "number" },
          },
          required: ["id", "team", "shirt", "role", "x", "y"],
          additionalProperties: false,
        },
      },
      ball: point,
      arrows: {
        type: "array",
        description: "Optional movement or passing arrows to illustrate the instruction; empty when none help.",
        items: {
          type: "object",
          properties: {
            from: point,
            to: point,
            team: { type: "string", enum: ["home", "away", "ball"] },
          },
          required: ["from", "to", "team"],
          additionalProperties: false,
        },
      },
      highlights: {
        type: "array",
        description: "Ids of players the instruction is about, to draw attention to them; empty when none.",
        items: { type: "string" },
      },
      title: { type: "string", description: "2 to 5 word name of what is shown" },
      note: {
        type: "string",
        description: "One or two short sentences for the coach: what changed and why it works.",
      },
    },
    required: ["pitch", "players", "ball", "arrows", "highlights", "title", "note"],
    additionalProperties: false,
  },
}

const zoomBox = {
  type: "object",
  description: "Camera for this frame in pitch metres. For the whole pitch use x=-4, y=-4, w=length+8, h=width+8. To zoom, give a box around the action at least 20 m wide, about the pitch's proportions.",
  properties: { x: { type: "number" }, y: { type: "number" }, w: { type: "number" }, h: { type: "number" } },
  required: ["x", "y", "w", "h"],
  additionalProperties: false,
}

const SET_PLAY = {
  name: "set_play",
  description:
    "Show a moving play as keyframes that the board animates and can loop: a set piece, a build-up pattern, a pressing trap, a counter. " +
    "players is the roster with starting positions; each frame lists where players are at that moment (only those who move need listing), the ball and the camera.",
  // Not strict: two strict schemas this size exceed the compiled-grammar limit. cleanPlay() validates instead.
  input_schema: {
    type: "object",
    properties: {
      pitch: SET_FORMATION.input_schema.properties.pitch,
      players: SET_FORMATION.input_schema.properties.players,
      ball: point,
      frames: {
        type: "array",
        description: "3 to 8 keyframes in order. Frame 1 is the starting picture.",
        items: {
          type: "object",
          properties: {
            label: { type: "string", description: "2 to 5 words, e.g. 'Full back overlaps'" },
            duration: { type: "number", description: "Seconds to move from the previous frame into this one (about the real time, 0.5 to 4)" },
            positions: {
              type: "array",
              description: "Players whose position at this frame differs from the previous frame",
              items: {
                type: "object",
                properties: { id: { type: "string" }, x: { type: "number" }, y: { type: "number" } },
                required: ["id", "x", "y"],
                additionalProperties: false,
              },
            },
            ball: point,
            zoom: zoomBox,
            arrows: SET_FORMATION.input_schema.properties.arrows,
            highlights: SET_FORMATION.input_schema.properties.highlights,
          },
          required: ["label", "duration", "positions", "ball", "zoom", "arrows", "highlights"],
          additionalProperties: false,
        },
      },
      title: SET_FORMATION.input_schema.properties.title,
      note: SET_FORMATION.input_schema.properties.note,
    },
    required: ["pitch", "players", "ball", "frames", "title", "note"],
    additionalProperties: false,
  },
}

// The basic version: results reach the model as they are (the 20260209 version filters them in code first,
// which came back to the model as "search failed" in testing).
const WEB_SEARCH = { type: "web_search_20250305", name: "web_search", max_uses: MAX_SEARCHES }

// The same tool, run by Touchline through PCP.
const PCP_WEB_SEARCH = {
  name: "web_search",
  description:
    "Search the web. Returns result titles, links and snippets. Use it for recent matches, named teams, coaches or players, and rules you are not sure of.",
  input_schema: {
    type: "object",
    properties: { query: { type: "string", description: "What to search for, a few words" } },
    required: ["query"],
    additionalProperties: false,
  },
}
const SEARCH_TOOL = PCP_ON ? PCP_WEB_SEARCH : VIA_TOKENS ? null : WEB_SEARCH
const TOOLS = [SET_FORMATION, SET_PLAY, ...(SEARCH_TOOL ? [SEARCH_TOOL] : [])]

const SEARCH_HINT = `You may use web_search when the instruction needs facts you are not sure of: a named team's, coach's or player's style, a league's or association's rules for a format, a famous goal or set piece. Search briefly (one or two searches), then answer with the tool. Never search for things you already know.`
const SYSTEM_BASE = `You are the assistant coach on a football (soccer) tactics board used by European coaches, from professionals to youth and recreational teams.
Coordinates are metres. x runs from 0 (the home team's goal line) to the pitch length; y from 0 (top touchline on screen) to the pitch width. The current pitch size comes with the board.
The home team (ids H1..Hn) defends the goal at x=0 and attacks towards the far goal line; its left flank is the top (small y), its right flank the bottom (large y).
The away team (ids A1..An) defends the far goal and attacks towards x=0; its left flank is the bottom (large y).
"Our"/"we" means home unless the instruction says otherwise. Read shirt numbers and roles from the board.
Formats change: when the coach names an age group, league or small-sided format, change the pitch size and the number of players on BOTH teams to match, with a sensible youth formation and shirts numbered 1..n. Know national youth formats; for the Netherlands (KNVB) for example: JO7 4 v 4 (no keeper) on about 30x20 m; JO8 and JO9 6 v 6 on a quarter pitch, about 42.5x30 m; JO10 and JO11 8 v 8 on a half pitch, about 64x42.5 m; JO12 and up 11 v 11 on a full pitch. Say in the note which format you used.
Drills and situations (a 2 v 1, 2 attackers against a defender and a keeper, 3 v 2, a rondo, 1 v 1 with the keeper, a finishing drill): put ONLY the players involved on the pitch (for example H1 and H2 attacking, A1 the keeper and A2 the defender, numbered from 1 per team), keep the pitch size, show it as a set_play, and zoom the camera onto the area where it happens. A drill may have one team without a keeper.
Otherwise move the players the instruction concerns realistically (keep the shape compact, keep players on the pitch, keep the opposition reacting sensibly) and leave everyone else where they are.
Two ways to answer, always exactly one tool call, listing every player who is on the pitch:
- set_formation for a still picture of where everyone stands (it changes only the frame the coach is looking at).
- set_play for anything that moves over time: a play, a pattern, a routine, a sequence, "show me how", "step by step". Give 3 to 8 keyframes with realistic timings, keep the ball moving believably (passes travel, players run onto them), and zoom the camera onto the action when it is in one area. If the board already has frames and the coach asks to change the play, return the whole play again with the change.
Arrows: team "home" or "away" for runs, "ball" for a pass or shot. Use them sparingly, and highlights for the players the instruction names.`
const SYSTEM = SEARCH_TOOL ? `${SYSTEM_BASE}\n${SEARCH_HINT}` : SYSTEM_BASE

// ---------------------------------------------------------------- helpers

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, Number.isFinite(v) ? v : (lo + hi) / 2))
const round1 = (v) => Math.round(v * 10) / 10
const cleanPitch = (p) => ({
  length: round1(clamp(Number(p?.length ?? PITCH.length), 20, 120)),
  width: round1(clamp(Number(p?.width ?? PITCH.width), 15, 90)),
})
const cleanPoint = (p, pitch = PITCH) => ({
  x: round1(clamp(Number(p?.x), 0, pitch.length)),
  y: round1(clamp(Number(p?.y), 0, pitch.width)),
})
const PLAYER_ID = /^[HA](?:[1-9]|1[01])$/

function sendJson(res, status, body, extra = {}) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(text),
    ...extra,
  })
  res.end(text)
}

// The last X-Forwarded-For hop is the one our own proxy (Traefik) wrote; any
// earlier one is the client's to invent.
function clientIp(req) {
  const xff = req.headers["x-forwarded-for"]
  if (typeof xff === "string" && xff.trim()) {
    const hops = xff.split(",").map((s) => s.trim()).filter(Boolean)
    if (hops.length) return hops[hops.length - 1]
  }
  return req.socket.remoteAddress ?? "unknown"
}

const hits = new Map() // ip -> timestamps within the window
function rateLimited(ip) {
  const now = Date.now()
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < RATE_WINDOW_MS)
  if (recent.length >= RATE_LIMIT) {
    hits.set(ip, recent)
    return Math.ceil((RATE_WINDOW_MS - (now - recent[0])) / 1000)
  }
  recent.push(now)
  hits.set(ip, recent)
  return 0
}
setInterval(() => {
  const now = Date.now()
  for (const [ip, ts] of hits) if (ts.every((t) => now - t >= RATE_WINDOW_MS)) hits.delete(ip)
}, RATE_WINDOW_MS).unref()

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on("data", (c) => {
      size += c.length
      if (size > MAX_BODY) {
        reject(Object.assign(new Error("Request body too large"), { status: 413 }))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
    req.on("error", reject)
  })
}

// Only the fields the model needs, so a client cannot stuff the prompt.
function stateForModel(state) {
  const pitch = cleanPitch(state?.pitch)
  const players = Array.isArray(state?.players) ? state.players : []
  return {
    pitch,
    players: players
      .filter((p) => PLAYER_ID.test(String(p?.id)))
      .slice(0, 22)
      .map((p) => ({
        id: p.id,
        team: p.id.startsWith("H") ? "home" : "away",
        shirt: Number.isInteger(p.shirt) ? p.shirt : Number(p.id.slice(1)),
        role: typeof p.role === "string" ? p.role.slice(0, 4) : "",
        ...cleanPoint(p, pitch),
      })),
    ball: cleanPoint(state?.ball ?? { x: pitch.length / 2, y: pitch.width / 2 }, pitch),
    lastNote: typeof state?.note === "string" ? state.note.slice(0, 400) : "",
    ...framesForModel(state, pitch),
  }
}

function framesForModel(state, pitch) {
  if (!Array.isArray(state?.frames) || state.frames.length < 2) return {}
  return {
    currentFrame: Number.isInteger(state.currentFrame) ? state.currentFrame : 1,
    frames: state.frames.slice(0, 16).map((f) => ({
      label: typeof f?.label === "string" ? f.label.slice(0, 40) : "",
      duration: round1(clamp(Number(f?.duration), 0.2, 10)),
      ball: cleanPoint(f?.ball, pitch),
      zoom: f?.zoom && ["x", "y", "w", "h"].every((k) => Number.isFinite(Number(f.zoom[k])))
        ? { x: round1(+f.zoom.x), y: round1(+f.zoom.y), w: round1(+f.zoom.w), h: round1(+f.zoom.h) }
        : "full pitch",
      positions: (Array.isArray(f?.positions) ? f.positions : [])
        .filter((p) => PLAYER_ID.test(String(p?.id)))
        .slice(0, 22)
        .map((p) => ({ id: p.id, ...cleanPoint(p, pitch) })),
    })),
  }
}

// The model's list is the new board: a player it leaves out is taken off,
// which is how a format change (11 v 11 to 8 v 8) happens.
function cleanPlan(input, previous) {
  const pitch = input?.pitch ? cleanPitch(input.pitch) : previous.pitch
  const seen = new Set()
  const players = []
  for (const p of Array.isArray(input?.players) ? input.players : []) {
    const id = String(p?.id)
    if (!PLAYER_ID.test(id) || seen.has(id)) continue
    seen.add(id)
    players.push({
      id,
      team: id.startsWith("H") ? "home" : "away",
      shirt: Number.isInteger(p.shirt) ? p.shirt : Number(id.slice(1)),
      role: typeof p.role === "string" ? p.role.slice(0, 4) : "",
      ...cleanPoint(p, pitch),
    })
  }
  const arrows = (Array.isArray(input?.arrows) ? input.arrows : []).slice(0, 12).map((a) => ({
    from: cleanPoint(a?.from, pitch),
    to: cleanPoint(a?.to, pitch),
    team: a?.team === "away" ? "away" : a?.team === "ball" ? "ball" : "home",
  }))
  const highlights = (Array.isArray(input?.highlights) ? input.highlights : [])
    .map(String)
    .filter((id) => seen.has(id))
    .slice(0, 22)
  return {
    pitch,
    players: players.length ? players : previous.players,
    ball: input?.ball ? cleanPoint(input.ball, pitch) : previous.ball,
    arrows,
    highlights,
    title: typeof input?.title === "string" ? input.title.slice(0, 60) : "",
    // Web search answers carry <cite index="..."> tags around quoted text; the board shows plain words.
    note: typeof input?.note === "string" ? input.note.replace(/<\/?cite[^>]*>/g, "").slice(0, 600) : "",
  }
}

function cleanPlay(input, previous) {
  const base = cleanPlan(input, previous)
  const pitch = base.pitch
  const ids = new Set(base.players.map((p) => p.id))
  const frames = (Array.isArray(input?.frames) ? input.frames : []).slice(0, 12).map((f, i) => ({
    label: typeof f?.label === "string" ? f.label.slice(0, 40) : `Frame ${i + 1}`,
    duration: round1(clamp(Number(f?.duration), 0.2, 10)),
    positions: (Array.isArray(f?.positions) ? f.positions : [])
      .filter((p) => ids.has(String(p?.id)))
      .map((p) => ({ id: String(p.id), ...cleanPoint(p, pitch) })),
    ball: cleanPoint(f?.ball, pitch),
    zoom: f?.zoom && ["x", "y", "w", "h"].every((k) => Number.isFinite(Number(f.zoom[k])))
      ? { x: round1(+f.zoom.x), y: round1(+f.zoom.y), w: round1(clamp(+f.zoom.w, 10, 130)), h: round1(clamp(+f.zoom.h, 8, 100)) }
      : null,
    arrows: (Array.isArray(f?.arrows) ? f.arrows : []).slice(0, 8).map((a) => ({
      from: cleanPoint(a?.from, pitch),
      to: cleanPoint(a?.to, pitch),
      team: a?.team === "away" ? "away" : a?.team === "ball" ? "ball" : "home",
    })),
    highlights: (Array.isArray(f?.highlights) ? f.highlights : []).map(String).filter((id) => ids.has(id)).slice(0, 6),
  }))
  return { ...base, kind: frames.length ? "play" : "formation", frames }
}

// Web pages Claude read, for the coach to see where an idea came from.
function sourcesOf(content) {
  const out = []
  for (const block of content ?? []) {
    if (block?.type !== "web_search_tool_result" || !Array.isArray(block.content)) continue
    for (const r of block.content) {
      if (r?.type === "web_search_result" && typeof r.url === "string" && !out.some((o) => o.url === r.url)) {
        out.push({ url: r.url, title: typeof r.title === "string" ? r.title.slice(0, 120) : r.url })
      }
    }
  }
  return out.slice(0, 5)
}

// ---------------------------------------------------------------- web search through PCP

// A minimal MCP client (Streamable HTTP): initialize once, then tools/call. PCP runs owner-allowed
// tools through its run_read entry, a small program that calls one tool: pcp.call(server, tool, args).
let pcpSession = null
let pcpReady = false
let rpcId = 0

function rpcResult(text, contentType, id) {
  if (!/event-stream/.test(contentType ?? "")) return JSON.parse(text)
  let found = null
  for (const line of text.split("\n")) {
    if (!line.startsWith("data:")) continue
    try {
      const msg = JSON.parse(line.slice(5))
      if (msg?.id === id) found = msg
    } catch {}
  }
  if (!found) throw new Error("PCP sent no answer")
  return found
}

async function mcp(method, params, { notify = false } = {}) {
  const headers = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    authorization: `Bearer ${PCP_TOKEN}`,
  }
  if (pcpSession) headers["mcp-session-id"] = pcpSession
  const id = ++rpcId
  const body = notify ? { jsonrpc: "2.0", method, params } : { jsonrpc: "2.0", id, method, params }
  const r = await fetch(PCP_URL, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(45_000) })
  const sid = r.headers.get("mcp-session-id")
  if (sid) pcpSession = sid
  const text = await r.text()
  if (notify) return null
  if (!r.ok) throw Object.assign(new Error(`PCP answered ${r.status}`), { status: r.status })
  const msg = rpcResult(text, r.headers.get("content-type"), id)
  if (msg.error) throw new Error(`PCP: ${String(msg.error.message ?? "error").slice(0, 200)}`)
  return msg.result
}

async function pcpInit() {
  if (pcpReady) return
  await mcp("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "touchline", version: "1.0.0" },
  })
  await mcp("notifications/initialized", {}, { notify: true })
  pcpReady = true
}

// The program PCP runs: call the search tool and, when it answers with DuckDuckGo's HTML results
// page, turn that into [{title, url, snippet}] there, so only a few hundred bytes come back.
// A bot-check page instead of results is an error, said in words.
function searchProgram(server, tool, args) {
  return `
const raw = await pcp.call(${JSON.stringify(server)}, ${JSON.stringify(tool)}, ${JSON.stringify(args)});
const page = typeof raw === "string" ? raw : null;
if (!page || !/<html|result__/i.test(page)) return raw;
if (!/result__a/.test(page)) {
  if (/anomaly/i.test(page)) throw new Error("DuckDuckGo refused the search with a bot check, so there are no results.");
  return [];
}
const text = (s) => String(s || "").replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\\s+/g, " ").trim();
const anchors = [...page.matchAll(/<a\\b([^>]*\\bclass="[^"]*\\bresult__a\\b[^"]*"[^>]*)>([\\s\\S]*?)<\\/a>/g)];
const out = [];
anchors.forEach((m, i) => {
  if (out.length >= 8) return;
  const href = (m[1].match(/\\bhref="([^"]*)"/) || [])[1] || "";
  const uddg = href.match(/[?&]uddg=([^&]+)/);
  let url = uddg ? decodeURIComponent(uddg[1]) : href.replace(/^\\/\\//, "https://");
  if (!/^https?:/.test(url) || /duckduckgo\\.com\\/y\\.js/.test(url)) return;
  const end = i + 1 < anchors.length ? anchors[i + 1].index : page.length;
  const rest = page.slice(m.index + m[0].length, end);
  const snip = rest.match(/class="[^"]*\\bresult__snippet\\b[^"]*"[^>]*>([\\s\\S]*?)<\\/(?:a|td|div)>/);
  out.push({ title: text(m[2]).slice(0, 160), url, snippet: text(snip && snip[1]).slice(0, 300) });
});
return out;`
}

async function pcpSearch(query) {
  const [server, tool] = PCP_SEARCH.split("/")
  const code = searchProgram(server, tool, { [PCP_SEARCH_ARG]: query })
  const call = async () => {
    await pcpInit()
    return mcp("tools/call", { name: PCP_RUN_TOOL, arguments: { code } })
  }
  let result
  try {
    result = await call()
  } catch (err) {
    // A session the server forgot (a restart): start a new one, once.
    if (err.status !== 400 && err.status !== 404) throw err
    pcpSession = null
    pcpReady = false
    result = await call()
  }
  const text = (result?.content ?? []).filter((c) => c?.type === "text").map((c) => c.text).join("\n")
  if (result?.isError) throw new Error(text.slice(0, 300) || "PCP refused the search")
  return text
}

// Links in a search answer, for the "Claude looked up" list.
const URL_RE = /https?:\/\/[^\s"'<>)\]\\]+/g
function linksOf(text) {
  const out = []
  for (const url of text.match(URL_RE) ?? []) {
    const clean = url.replace(/[.,;:]+$/, "")
    if (!out.some((o) => o.url === clean)) out.push({ url: clean, title: clean.replace(/^https?:\/\/(www\.)?/, "").slice(0, 120) })
  }
  return out
}

// ---------------------------------------------------------------- /api/plan

async function plan(req, res) {
  const apiKey = VIA_TOKENS ? TOKENS_APP_KEY : process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    return sendJson(res, 503, {
      error: "The server has no ANTHROPIC_API_KEY (or TOKENS_URL and TOKENS_APP_KEY) set, so it cannot ask Claude.",
    })
  }

  const wait = rateLimited(clientIp(req))
  if (wait) {
    return sendJson(
      res,
      429,
      { error: `Too many requests. Try again in ${wait} s.` },
      { "retry-after": String(wait) },
    )
  }

  let body
  try {
    body = JSON.parse(await readBody(req))
  } catch (err) {
    return sendJson(res, err.status ?? 400, { error: err.status ? err.message : "Body must be JSON" })
  }
  const prompt = typeof body?.prompt === "string" ? body.prompt.trim() : ""
  if (!prompt) return sendJson(res, 400, { error: "Say or type an instruction first." })
  if (prompt.length > 1000) return sendJson(res, 400, { error: "Keep the instruction under 1000 characters." })

  const current = stateForModel(body.state)
  const messages = [
    {
      role: "user",
      content: `Current board (JSON):\n${JSON.stringify(current)}\n\nCoach's instruction: ${prompt}`,
    },
  ]
  const headers = {
    "content-type": "application/json",
    "x-api-key": apiKey,
    "anthropic-version": "2023-06-01",
  }
  if (FALLBACKS) headers["anthropic-beta"] = "server-side-fallback-2026-07-01"
  if (VIA_TOKENS) {
    // One shared user pays for every visitor; the purpose and activity show on the center's ledger.
    headers["x-token-user"] = encodeURIComponent(TOKENS_USER)
    headers["x-token-purpose"] = "touchline"
    headers["x-token-activity"] = "plan"
  }

  const started = Date.now()
  const found = [] // links from searches run through PCP
  let searches = 0
  const content = [] // everything Claude said, across continuations
  let model = MODEL
  // A server-side search can pause the turn (pause_turn); a turn can also end
  // with words and no board. Each is continued, a few times at most.
  for (let round = 0; round < 6; round++) {
    const left = TOTAL_MS - (Date.now() - started)
    if (left < 5000) break
    const request = {
      model: MODEL,
      max_tokens: 16000,
      system: SYSTEM,
      tools: TOOLS,
      // Forced tool_choice is refused (400) by Sonnet 5.5 / Opus 5.5, so the
      // prompt requires the call and strict mode holds its arguments.
      tool_choice: { type: "auto" }, // parallel calls stay allowed: web_search_20260209 (programmatic) refuses disable_parallel_tool_use
      messages,
    }
    if (EFFORT !== "none") request.output_config = { effort: EFFORT }
    if (FALLBACKS) request.fallbacks = "default"

    let upstream
    try {
      upstream = await fetch(API_URL, {
        method: "POST",
        headers,
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(Math.min(TIMEOUT_MS, left)),
      })
    } catch (err) {
      const timedOut = err?.name === "TimeoutError" || err?.name === "AbortError"
      console.error(`[plan] upstream ${timedOut ? "timeout" : "network error"}: ${err?.name}`)
      return sendJson(res, timedOut ? 504 : 502, {
        error: timedOut ? "Claude took too long. Try a shorter instruction." : "Could not reach Claude.",
      })
    }

    let data
    try {
      data = await upstream.json()
    } catch {
      data = null
    }

    if (!upstream.ok) {
      // Log the status and the error type only: never the key, never the prompt.
      const type = data?.error?.type ?? "unknown"
      console.error(`[plan] upstream ${upstream.status} ${type} ${String(data?.error?.message ?? "").slice(0, 200)}`)
      const status = upstream.status === 429 || upstream.status === 529 ? 503 : 502
      const message =
        upstream.status === 401
          ? "The server's Anthropic API key was refused."
          : upstream.status === 429 || upstream.status === 529
            ? "Claude is busy right now. Try again in a moment."
            : `Claude answered with an error (${upstream.status} ${type}).`
      return sendJson(res, status, { error: message })
    }

    model = data?.model ?? model
    const blocks = Array.isArray(data?.content) ? data.content : []
    content.push(...blocks)
    if (data?.stop_reason === "refusal") {
      return sendJson(res, 422, { error: "Claude declined that instruction. Try rewording it." })
    }
    const call = blocks.find((b) => b.type === "tool_use" && (b.name === "set_formation" || b.name === "set_play"))
    if (call) {
      const plan = call.name === "set_play" ? cleanPlay(call.input, current) : { ...cleanPlan(call.input, current), kind: "formation" }
      searches += content.filter((b) => b.type === "server_tool_use").length
      const sources = [...sourcesOf(content), ...found].filter((s, i, all) => all.findIndex((o) => o.url === s.url) === i).slice(0, 5)
      console.log(`[plan] ${call.name} rounds=${round + 1} searches=${searches} via=${VIA_TOKENS ? "tokens" : "anthropic"} ${Date.now() - started}ms`)
      return sendJson(res, 200, { ...plan, sources, model })
    }
    messages.push({ role: "assistant", content: blocks })
    if (data?.stop_reason === "pause_turn") continue // the server resumes the search by itself
    const asks = blocks.filter((b) => b.type === "tool_use" && b.name === "web_search")
    if (PCP_ON && asks.length) {
      // Run Claude's searches here, through PCP, and hand back what came of each.
      const results = []
      for (const ask of asks) {
        let text
        let isError = false
        if (searches >= MAX_SEARCHES) {
          text = "Search limit reached. Draw the board now with what you know."
          isError = true
        } else {
          searches++
          try {
            text = (await pcpSearch(String(ask.input?.query ?? "").slice(0, 300))).slice(0, 8000)
            found.push(...linksOf(text))
          } catch (err) {
            console.error(`[plan] pcp search failed: ${String(err?.message).slice(0, 200)}`)
            text = "The search did not work. Draw the board from what you know and say so in the note."
            isError = true
          }
        }
        results.push({ type: "tool_result", tool_use_id: ask.id, content: text, ...(isError ? { is_error: true } : {}) })
      }
      messages.push({ role: "user", content: results })
      continue
    }
    if (asks.length) {
      // A search tool Claude cannot use here: answer it so the conversation stays valid.
      messages.push({ role: "user", content: asks.map((a) => ({ type: "tool_result", tool_use_id: a.id, content: "Search is not available. Draw the board now.", is_error: true })) })
      continue
    }
    messages.push({ role: "user", content: "Now draw it: call set_formation or set_play." })
  }
  console.error(`[plan] no tool call after continuing`)
  return sendJson(res, 502, { error: "Claude did not return a board. Try again." })
}

// ---------------------------------------------------------------- server

let indexHtml
async function page() {
  if (!indexHtml || process.env.NODE_ENV !== "production") {
    indexHtml = await readFile(join(HERE, "public", "index.html"))
  }
  return indexHtml
}

const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "permissions-policy": "microphone=(self), camera=(), geolocation=()",
  "content-security-policy":
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; " +
    "img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
}

const server = createServer(async (req, res) => {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v)
  const { pathname } = new URL(req.url ?? "/", "http://localhost")
  try {
    if (pathname === "/healthz") {
      res.writeHead(200, { "content-type": "text/plain", "cache-control": "no-store" })
      return res.end("ok")
    }
    if (pathname === "/api/plan") {
      if (req.method !== "POST") return sendJson(res, 405, { error: "Use POST" }, { allow: "POST" })
      return await plan(req, res)
    }
    if (pathname === "/" || pathname === "/index.html") {
      if (req.method !== "GET" && req.method !== "HEAD") return sendJson(res, 405, { error: "Use GET" })
      const html = await page()
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-length": html.length })
      return res.end(req.method === "HEAD" ? undefined : html)
    }
    sendJson(res, 404, { error: "Not found" })
  } catch (err) {
    console.error(`[server] ${err?.name}: ${err?.message}`)
    if (!res.headersSent) sendJson(res, 500, { error: "Something went wrong" })
    else res.end()
  }
})

server.requestTimeout = 130_000
server.listen(PORT, HOST, () => {
  const via = VIA_TOKENS ? `Token Center ${TOKENS_URL} as ${TOKENS_USER}` : `Anthropic, key ${process.env.ANTHROPIC_API_KEY ? "set" : "NOT set"}`
  const search = PCP_ON ? `PCP ${PCP_SEARCH}` : SEARCH_TOOL ? "Anthropic web search" : "none"
  console.log(`Touchline on http://${HOST}:${PORT} (model ${MODEL}, via ${via}, search ${search})`)
})

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 5000).unref()
  })
}
