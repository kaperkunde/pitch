# Touchline

An iPad-friendly football tactics board. A coach speaks or types an instruction ("move the back
four up ten metres, left winger tuck inside, press their keeper"); the server asks Claude for new
positions of all 22 players, the ball and optional arrows and highlights, and the page animates the
players there on an SVG pitch (105 x 68 m, home attacking right, 4-3-3 against 4-3-3 to start).

- `server.js` - plain Node 24 (`node:http`, no dependencies). Serves `public/index.html`,
  `GET /healthz` (`ok`) and `POST /api/plan` `{prompt, state}`.
- `public/index.html` - the whole page: inline CSS and JS, no external hosts. Voice through the Web
  Speech API (`webkitSpeechRecognition`) where the browser has it, a text box always (the iPad
  keyboard's dictation key works too), drag a player to move it by hand, Undo, Reset.

## Run

```sh
export ANTHROPIC_API_KEY=...        # required for /api/plan; never logged
node server.js                      # http://localhost:3000
```

Or with Docker:

```sh
docker build -t touchline .
docker run --rm -p 3000:3000 -e ANTHROPIC_API_KEY touchline
```

Without a key the page still loads and `/api/plan` answers `503` with
`{"error": "The server has no ANTHROPIC_API_KEY set, ..."}`.

Voice input needs a secure context (HTTPS, or localhost).

## Settings (environment)

| Variable | Default | What it does |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | (none) | Sent as `x-api-key` to `https://api.anthropic.com/v1/messages` |
| `ANTHROPIC_MODEL` | `claude-sonnet-5-5` | Model asked |
| `ANTHROPIC_EFFORT` | `low` | `output_config.effort`; `none` leaves it out (for a model without effort) |
| `ANTHROPIC_FALLBACKS` | on | Server-side refusal fallback (`fallbacks: "default"`, beta `server-side-fallback-2026-07-01`); `off` turns it off |
| `RATE_LIMIT_PER_MINUTE` | `12` | Plans per client IP per minute (last `X-Forwarded-For` hop, else the socket) |
| `ANTHROPIC_BASE_URL` | `https://api.anthropic.com` | For a proxy or a local stand-in in tests |
| `PORT` / `HOST` | `3000` / `0.0.0.0` | Where it listens |

## How the plan is asked for

One Messages API call with a strict tool, `set_formation`
(`{players: [{id, team, x, y}], ball: {x, y}, arrows: [{from, to, team}], highlights: [id], note}`).
Claude Sonnet 5.5 refuses a forced `tool_choice` (`any`/`tool`) with a 400, so the call uses
`tool_choice: auto` with parallel calls off, the system prompt requires exactly one
`set_formation` call, and `strict: true` holds the arguments to the schema. The server then clamps
every coordinate onto the pitch, keeps any player the model left out where it was, and answers the
cleaned plan. 30 s timeout; a refusal, a timeout, a busy API or a missing tool call each come back
as a plain error the page shows in the coach's-note line.

Player ids are `H1`-`H11` (home) and `A1`-`A11` (away); the number is the shirt number of a 4-3-3:
1 GK, 2 RB, 3 LB, 4/5 CB, 6 DM, 8/10 CM, 7 RW, 9 ST, 11 LW.

## Token Center and web search through PCP

Two ways to reach Claude, chosen by the environment:

| Variable | Meaning |
| --- | --- |
| `TOKENS_URL`, `TOKENS_APP_KEY` | Both set: every call goes through the Token Center's gateway (`$TOKENS_URL/v1/messages`) with this app key. Anthropic's server-side tools are left out, since the center does not price them, and the refusal fallback is off. |
| `TOKENS_USER` | The one Token Center user every visitor's calls are charged to (default `pitch-public`). Give it credit from the center's admin (Grants: Anthropic, no expiry). |
| `ANTHROPIC_API_KEY` | Used only when the two above are not set: straight to Anthropic, with Anthropic's own web search. |
| `PCP_URL`, `PCP_TOKEN` | A PCP MCP endpoint and Touchline's own token for it. With `PCP_SEARCH` set, Claude gets a `web_search` tool that Touchline runs itself through PCP, in either mode. |
| `PCP_SEARCH` | The PCP tool to search with, as `server/tool`. |
| `PCP_SEARCH_ARG` | That tool's query argument (default `query`). |
| `PCP_RUN_TOOL` | The PCP entry that runs it (default `run_read`, which calls `pcp.call(server, tool, {query})`). |
| `MAX_SEARCHES` | Searches per instruction (default 3). |

The startup line in the logs says which way it runs: `via Token Center … as pitch-public, search PCP …`.
