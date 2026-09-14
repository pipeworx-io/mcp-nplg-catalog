interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    throw err;
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse$shared whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse$shared(decodeEntities$shared(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities$shared(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse$shared(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * Written as a sentence rather than a sigil because it is going to be read by
 * whoever gets the error, and "our own service, not a third party" is the
 * single most useful thing to tell them — fetchWithTimeout's own comment
 * (fleet #1047) is about exactly this ambiguity, where blaming a healthy vendor
 * by name sent the next person waiting for an outage that did not exist.
 */
const INTERNAL_ORIGIN_MARKER = ' [pipeworx-hosted origin — our own service, not a third party]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}
/**
 * National Parliamentary Library of Georgia MCP — the union catalogue and the
 * digital library, both published by the library itself.
 *
 * Auth: none. Every request below answers without a credential.
 *
 * Two systems, one institution:
 *   - catalog.nplg.gov.ge      Innovative Interfaces Sierra, classic WebPAC Pro
 *   - www.nplg.gov.ge/dlibrary static-HTML digital library
 *
 * A Sierra REST API v6.1.0 is live at /iii/sierra-api/v6/ but 401s without a
 * library-issued client key, so everything here reads the keyless WebPAC that
 * the same server renders for the public. A key from NPLG would turn these
 * HTML parses into a supported JSON API; nothing else about the pack changes.
 *
 * Traps, every one of which returns a plausible 200 rather than an error:
 *   - The phrase indexes (/search*eng/t, /a, /d) return an alphabetical LIST OF
 *     HEADINGS, not records — 0 brief citations on a 200. Searching by title or
 *     author therefore goes through the keyword index with III's own field
 *     qualifier, `t:(...)` / `a:(...)` / `d:(...)`, which is verified to return
 *     real citations.
 *   - The offset cursor carries the result total inside the URL path
 *     (`51,2896,2896,B`). Pass a wrong total and the page still returns rows,
 *     with a header that reports a total that is not the search's — a clean 200
 *     that quietly lies about how much there is. So an offset request here
 *     reads the real total from the first page before it asks for the offset.
 *   - A no-hit search is a 200 with "NO ENTRIES FOUND" and a spelling
 *     suggestion block, not a 404.
 *   - The Georgian interface (/search*geo) labels the MARC leader "ლიდერი" and
 *     the result header in Georgian. The pack asks for /search*eng so the
 *     labels are stable; the records themselves are unchanged and stay in the
 *     language they were catalogued in.
 */


const UA = 'pipeworx-mcp-nplg-catalog/1.0 (+https://pipeworx.io)';

const CATALOG = 'https://catalog.nplg.gov.ge';
const DLIBRARY = 'http://www.nplg.gov.ge/dlibrary';

const UPSTREAM_CATALOG = 'National Library of Georgia catalogue (Sierra WebPAC)';
const UPSTREAM_DLIBRARY = 'National Library of Georgia digital library';

/** The WebPAC returns 50 brief citations per page and does not let you change it. */
const CATALOG_PAGE_SIZE = 50;
/** The digital library returns 10 hits per page, paged with `pg=`. */
const DLIBRARY_PAGE_SIZE = 10;

async function pwFetch(url: string | URL, upstream: string): Promise<Response> {
  return fetchWithTimeout(url, { headers: { 'User-Agent': UA } }, upstream);
}

/** III field qualifiers usable inside the keyword index. The phrase indexes of
 *  the same letters browse headings instead of returning records. */
const SEARCH_QUALIFIERS: Record<string, string | null> = {
  keyword: null,
  title: 't',
  author: 'a',
  subject: 'd',
};

/** searchscope values, read off the search form's own <option> list. */
const SCOPES: Record<number, string> = {
  1: 'View Entire Collection',
  2: 'Books',
  3: 'Periodicals',
  4: 'Posters and prints',
  5: 'Cartographical publications',
  6: 'Electronic resources',
  7: 'Dissertations and abstracts',
  8: 'Music and audio editions',
  9: 'Archival documents',
  10: 'Newspaper Articles',
  11: 'Journal Articles',
};

const tools: McpToolExport['tools'] = [
  {
    name: 'nplg_search',
    description:
      'Search the union catalogue of the National Parliamentary Library of Georgia by keyword, title, author or subject. Returns the true number of matching records alongside the page of citations, each with its permanent bib id, title (Georgian with a parallel Latin title where the record carries one), author, imprint and material type. Queries work in Georgian (მხედრული) or Latin script. Narrow by material with `scope` (books, periodicals, maps, dissertations, archival documents…). Pages 50 at a time via `offset`.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description: 'Search terms. Georgian or Latin script both work; "and"/"or"/"not" are honoured.',
        },
        index: {
          type: 'string',
          description: 'Which index to search: keyword (default), title, author, subject.',
          enum: ['keyword', 'title', 'author', 'subject'],
        },
        scope: {
          type: 'integer',
          description:
            'Material scope, 1-11. 1 = entire collection (default), 2 books, 3 periodicals, 4 posters and prints, 5 cartographical, 6 electronic, 7 dissertations, 8 music and audio, 9 archival documents, 10 newspaper articles, 11 journal articles.',
        },
        offset: {
          type: 'integer',
          description: 'Zero-based record offset for paging; the page size is 50. Pass 50 for the second page.',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'nplg_record_marc',
    description:
      'Fetch the full MARC record for one bib id in the National Parliamentary Library of Georgia catalogue (the `bib_id` nplg_search returns, e.g. "b4972685"). Returns the leader, control fields and every data field with its indicators and subfields kept separate — so the 041 language codes and the parallel Georgian/English 245 stay machine-readable rather than flattened into one string.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        bib_id: {
          type: 'string',
          description: 'Sierra bib id as returned by nplg_search, e.g. "b4972685". The leading "b" is optional.',
        },
      },
      required: ['bib_id'],
    },
  },
  {
    name: 'nplg_dlibrary_search',
    description:
      'Search the digital library of the National Parliamentary Library of Georgia — a small full-text collection of scanned print archive, dissertations and posters. Each hit carries authors, date of issue, a full source citation, subject headings in Georgian, Russian and English, a Dewey subject and a stable item URL. Pages 10 at a time.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Search terms. Georgian or Latin script both work.' },
        collection: {
          type: 'string',
          description: 'Which collection to search: all (default), print_archive, dissertations, posters.',
          enum: ['all', 'print_archive', 'dissertations', 'posters'],
        },
        page: { type: 'integer', description: '1-based page number; the page size is 10.' },
      },
      required: ['query'],
    },
  },
];

// ------------------------------------------------------------------ helpers

/** The WebPAC writes most Georgian as numeric character references
 *  (`&#4315;` = მ) and punctuation as `&#59;` / `&#34;`, so a decoder that only
 *  knows the five named entities hands back mojibake that still looks like a
 *  successful parse. */
function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&');
}

function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function textOf(fragment: string): string {
  return collapse(decodeEntities(fragment.replace(/<[^>]*>/g, ' ')));
}

/** Split a markup fragment into its visible lines, <br> being the separator. */
function linesOf(fragment: string): string[] {
  return fragment
    .replace(/<br\s*\/?>/gi, '\u0000')
    .replace(/<[^>]*>/g, ' ')
    .split('\u0000')
    .map((line) => collapse(decodeEntities(line)))
    .filter(Boolean);
}

// ------------------------------------------------------------------- search

type BriefCitation = {
  bib_id: string | null;
  title: string | null;
  title_parts: string[] | null;
  author: string | null;
  imprint: string | null;
  other_citation_lines: string[] | null;
  material_type: string | null;
  catalogue_url: string | null;
};

const YEAR = /\b(1[5-9]\d{2}|20\d{2})\b/;

function parseBriefCitations(html: string): BriefCitation[] {
  const out: BriefCitation[] = [];
  for (const m of html.matchAll(/<div class="briefcitRow">([\s\S]*?)<div class="briefcitClear">/g)) {
    const row = m[1];
    const bibId = /name="save"\s+value="(b\d+)"/.exec(row)?.[1] ?? null;
    const titleMatch = /<h2 class="briefcitTitle">\s*<a[^>]*>([\s\S]*?)<\/a>/.exec(row);
    const title = titleMatch ? textOf(titleMatch[1]) : null;

    // The citation lines sit between the title anchor and the first of the UI
    // blocks that follow it. One line means the record has no author heading —
    // it is the imprint alone, and reading it as an author is the easy mistake.
    let author: string | null = null;
    let imprint: string | null = null;
    let extra: string[] = [];
    if (titleMatch) {
      const rest = row.slice(titleMatch.index + titleMatch[0].length);
      const cut = /<div class="briefcit(?:Ratings|Actions|Items)"|<span class="briefcitStatus"/.exec(rest);
      const lines = linesOf(cut ? rest.slice(0, cut.index) : rest);
      if (lines.length === 1) {
        if (YEAR.test(lines[0])) imprint = lines[0];
        else author = lines[0];
      } else if (lines.length > 1) {
        author = lines[0];
        imprint = lines[lines.length - 1];
        extra = lines.slice(1, -1);
      }
    }

    out.push({
      bib_id: bibId,
      title,
      title_parts: title && title.includes(' = ') ? title.split(' = ').map((p) => p.trim()) : null,
      author,
      imprint,
      other_citation_lines: extra.length ? extra : null,
      material_type: /<img[^>]*\sALT="([^"]*)"/i.exec(row)?.[1] ?? null,
      catalogue_url: bibId ? `${CATALOG}/record=${bibId}*eng` : null,
    });
  }
  return out;
}

/** "Keywords (51-100 of 2896)" — first, last, total. */
function parseResultHeader(html: string): { first: number; last: number; total: number } | null {
  // Several header cells exist and only the result one carries the triple, so
  // scan them all rather than anchoring on the first.
  for (const cell of html.matchAll(/class="browseHeaderData">([^<]*)/g)) {
    const m = /\((\d+)-(\d+) of (\d+)\)/.exec(cell[1]);
    if (m) return { first: Number(m[1]), last: Number(m[2]), total: Number(m[3]) };
  }
  return null;
}

function searchUrl(term: string, scope: number): string {
  // SEARCH= is the first-page form; the index letter X is the keyword index.
  return `${CATALOG}/search*eng/X?SEARCH=${encodeURIComponent(term)}&searchscope=${scope}&SORT=D`;
}

/** III's native offset cursor. The `first,last,total` triple is part of the
 *  path, and the total has to be the search's real one — see the header note. */
function offsetUrl(term: string, scope: number, offset: number, total: number): string {
  const q = `X${encodeURIComponent(term)}&searchscope=${scope}&SORT=D`;
  const cursor = `${offset + 1}%2C${total}%2C${total}%2CB`;
  return `${CATALOG}/search~S${scope}*eng?/${q}/${q}&SUBKEY=${encodeURIComponent(term)}/${cursor}/browse`;
}

async function fetchCatalogPage(url: string): Promise<string> {
  const res = await pwFetch(url, UPSTREAM_CATALOG);
  if (!res.ok) throw await httpError(res, UPSTREAM_CATALOG);
  return res.text();
}

async function search(args: Record<string, unknown>): Promise<unknown> {
  const query = String(args.query ?? '').trim();
  if (!query) throw new Error('nplg_search: `query` is required.');

  const indexName = String(args.index ?? 'keyword');
  if (!(indexName in SEARCH_QUALIFIERS)) {
    throw new Error(
      `nplg_search: unknown index "${indexName}" — use one of ${Object.keys(SEARCH_QUALIFIERS).join(', ')}.`,
    );
  }
  const qualifier = SEARCH_QUALIFIERS[indexName];
  const term = qualifier ? `${qualifier}:(${query})` : query;

  const scope = Math.trunc(Number(args.scope ?? 1) || 1);
  if (!SCOPES[scope]) {
    throw new Error(`nplg_search: \`scope\` must be 1-11 (1 = entire collection); got ${scope}.`);
  }

  const offset = Math.max(0, Math.trunc(Number(args.offset ?? 0) || 0));

  let url = searchUrl(term, scope);
  let html = await fetchCatalogPage(url);
  let header = parseResultHeader(html);

  if (offset > 0) {
    if (!header) {
      // No header and an offset asked for means there is nothing to page into.
      return emptyResult(query, indexName, scope, offset, url, html);
    }
    if (offset >= header.total) {
      throw new Error(
        `nplg_search: offset ${offset} is past the end of this result set (${header.total} records for "${query}").`,
      );
    }
    url = offsetUrl(term, scope, offset, header.total);
    html = await fetchCatalogPage(url);
    const paged = parseResultHeader(html);
    if (paged) header = paged;
  }

  const records = parseBriefCitations(html);
  if (records.length === 0) return emptyResult(query, indexName, scope, offset, url, html);

  const first = header ? header.first - 1 : offset;
  const total = header ? header.total : records.length;

  return {
    query,
    index: indexName,
    scope,
    scope_name: SCOPES[scope],
    total,
    returned: records.length,
    offset: first,
    page_size: CATALOG_PAGE_SIZE,
    next_offset: first + records.length < total ? first + records.length : null,
    records,
    source: url,
  };
}

/** A no-hit search is a 200 carrying "NO ENTRIES FOUND", so say so rather than
 *  returning a bare empty list that reads as a broken parse. */
function emptyResult(
  query: string,
  indexName: string,
  scope: number,
  offset: number,
  url: string,
  html: string,
): unknown {
  const noEntries = /NO ENTRIES FOUND/i.test(html);
  if (!noEntries) {
    throw new Error(
      `${UPSTREAM_CATALOG}: the result page for "${query}" carried neither citations nor a no-hits message — its HTML layout may have changed.`,
    );
  }
  return {
    query,
    index: indexName,
    scope,
    scope_name: SCOPES[scope],
    total: 0,
    returned: 0,
    offset,
    page_size: CATALOG_PAGE_SIZE,
    next_offset: null,
    records: [],
    note: 'No entries found for this search.',
    source: url,
  };
}

// -------------------------------------------------------------- MARC record

type MarcSubfield = { code: string; value: string };
type MarcField = { tag: string; ind1: string; ind2: string; value?: string; subfields?: MarcSubfield[] };

function parseMarcSubfields(data: string): MarcSubfield[] {
  const parts = data.split('|');
  const out: MarcSubfield[] = [];
  // III prints the first subfield without its delimiter; in MARC that is $a.
  if (parts[0].trim()) out.push({ code: 'a', value: parts[0].trim() });
  for (const p of parts.slice(1)) {
    if (!p) continue;
    out.push({ code: p[0], value: p.slice(1).trim() });
  }
  return out;
}

function parseMarc(pre: string): { leader: string | null; fields: MarcField[] } {
  // Column positions are load-bearing here (tag 0-2, indicators 4-5, data from
  // 7), so tags come out without substituting a space and nothing collapses.
  const lines = decodeEntities(pre.replace(/<[^>]*>/g, ''))
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''));
  let leader: string | null = null;
  const fields: MarcField[] = [];
  const raws: string[] = [];

  for (const line of lines) {
    if (!line.trim()) continue;
    // A wrapped field continues on a line indented past the data column.
    if (/^\s{7}/.test(line)) {
      if (raws.length) raws[raws.length - 1] += ` ${line.trim()}`;
      continue;
    }
    const leaderMatch = /^(?:LEADER|ლიდერი)\s+(.*)$/.exec(line);
    if (leaderMatch) {
      leader = leaderMatch[1].trim();
      continue;
    }
    if (!/^\d{3}/.test(line)) continue;
    fields.push({ tag: line.slice(0, 3), ind1: line.slice(4, 5) || ' ', ind2: line.slice(5, 6) || ' ' });
    raws.push(line.slice(7));
  }

  fields.forEach((f, i) => {
    const data = raws[i].trim();
    // 001-009 are control fields: no indicators, no subfields.
    if (Number(f.tag) < 10) f.value = data;
    else f.subfields = parseMarcSubfields(data);
  });

  return { leader, fields };
}

function subfieldValues(fields: MarcField[], tags: string[], codes: string): string[] {
  const out: string[] = [];
  for (const f of fields) {
    if (!tags.includes(f.tag)) continue;
    for (const sf of f.subfields ?? []) {
      if (codes.includes(sf.code) && sf.value) out.push(sf.value.replace(/\s*[\/:;,=]\s*$/, '').trim());
    }
  }
  return out.filter(Boolean);
}

function summarizeMarc(fields: MarcField[]) {
  const title = subfieldValues(fields, ['245'], 'abnp').join(' ');
  return {
    title: title || null,
    statement_of_responsibility: subfieldValues(fields, ['245'], 'c')[0] ?? null,
    authors: subfieldValues(fields, ['100', '110', '111', '700', '710'], 'ab'),
    imprint: subfieldValues(fields, ['260', '264'], 'abc').join(' ') || null,
    isbn: subfieldValues(fields, ['020'], 'a'),
    issn: subfieldValues(fields, ['022'], 'a'),
    physical_description: subfieldValues(fields, ['300'], 'abc'),
    languages: subfieldValues(fields, ['041'], 'abh'),
    classification: subfieldValues(fields, ['080', '082', '084'], 'a'),
    subjects: subfieldValues(fields, ['600', '610', '611', '630', '650', '651', '653'], 'axyz'),
    notes: subfieldValues(fields, ['500', '504', '546'], 'a'),
    in: subfieldValues(fields, ['773'], 'tdgh').join(' ') || null,
  };
}

async function recordMarc(args: Record<string, unknown>): Promise<unknown> {
  const raw = String(args.bib_id ?? '').trim();
  const bibId = /^b?\d+$/.test(raw) ? (raw.startsWith('b') ? raw : `b${raw}`) : null;
  if (!bibId) {
    throw new Error('nplg_record_marc: `bib_id` must be a Sierra bib id from nplg_search, e.g. "b4972685".');
  }

  const url = `${CATALOG}/search*eng/.${bibId}/.${bibId}/1%2C1%2C1%2CB/marc`;
  const res = await pwFetch(url, UPSTREAM_CATALOG);
  if (!res.ok) throw await httpError(res, UPSTREAM_CATALOG);
  const html = await res.text();

  const pre = /<pre[^>]*>([\s\S]*?)<\/pre>/.exec(html)?.[1];
  if (!pre) {
    throw new Error(
      `${UPSTREAM_CATALOG}: no MARC block on the page for ${bibId} — the bib id may not exist, or the record may be suppressed.`,
    );
  }

  const { leader, fields } = parseMarc(pre);
  if (fields.length === 0) {
    throw new Error(`${UPSTREAM_CATALOG}: the MARC block for ${bibId} carried no parseable fields.`);
  }

  return {
    bib_id: bibId,
    summary: summarizeMarc(fields),
    marc: { leader, fields },
    field_count: fields.length,
    catalogue_url: `${CATALOG}/record=${bibId}*eng`,
    source: url,
  };
}

// ---------------------------------------------------------- digital library

const DLIBRARY_COLLECTIONS: Record<string, number> = {
  all: 0,
  print_archive: 1,
  dissertations: 2,
  posters: 3,
};

async function dlibrarySearch(args: Record<string, unknown>): Promise<unknown> {
  const query = String(args.query ?? '').trim();
  if (!query) throw new Error('nplg_dlibrary_search: `query` is required.');

  const collectionName = String(args.collection ?? 'all');
  const co = DLIBRARY_COLLECTIONS[collectionName];
  if (co === undefined) {
    throw new Error(
      `nplg_dlibrary_search: unknown collection "${collectionName}" — use one of ${Object.keys(DLIBRARY_COLLECTIONS).join(', ')}.`,
    );
  }
  const page = Math.max(1, Math.trunc(Number(args.page ?? 1) || 1));

  const url = new URL(`${DLIBRARY}/search.html`);
  url.searchParams.set('qs', query);
  url.searchParams.set('co', String(co));
  if (page > 1) url.searchParams.set('pg', String(page));

  const res = await pwFetch(url, UPSTREAM_DLIBRARY);
  if (!res.ok) throw await httpError(res, UPSTREAM_DLIBRARY);
  const html = await res.text();

  const header = /Search result:\s*(\d+)-(\d+)\s*\/\s*(\d+)/.exec(html);
  // Each item block contains a nested <table> of detail rows, so a non-greedy
  // match to </table> stops inside it. Split on the opening tag instead.
  const items = html
    .split('<table class="itlist"')
    .slice(1)
    .map((block) => {
      const itemUrl = /<p class="ttl">\s*<a href="([^"]+)"/.exec(block)?.[1] ?? null;
      const title = textOf(/<p class="ttl">\s*<a[^>]*>([\s\S]*?)<\/a>/.exec(block)?.[1] ?? '') || null;
      const details: Record<string, string> = {};
      for (const d of block.matchAll(
        /<td class="dtl">([\s\S]*?)<\/td>\s*<td class="dtr">([\s\S]*?)<\/td>/g,
      )) {
        details[textOf(d[1]).replace(/:$/, '')] = textOf(d[2]);
      }
      const subjects = (details['Subjects'] ?? '')
        .split(';')
        .map((s) => s.trim())
        .filter(Boolean);
      return {
        title,
        authors: details['Authors'] ?? null,
        date_of_issue: details['Date of Issue'] ?? null,
        source_citation: details['Source'] ?? null,
        // Georgian, Russian and English headings for the same subject, as filed.
        subjects: subjects.length ? subjects : null,
        ddc_subject: details['DDC Subject'] ?? null,
        collection: textOf(/<p class="coln">([\s\S]*?)<\/p>/.exec(block)?.[1] ?? '').replace(/^Collection:\s*/, '') || null,
        item_url: itemUrl,
      };
    });

  const total = header ? Number(header[3]) : items.length;

  if (items.length === 0 && !header) {
    throw new Error(
      `${UPSTREAM_DLIBRARY}: the result page for "${query}" carried neither items nor a result count — its HTML layout may have changed.`,
    );
  }

  return {
    query,
    collection: collectionName,
    total,
    returned: items.length,
    page,
    page_size: DLIBRARY_PAGE_SIZE,
    next_page: page * DLIBRARY_PAGE_SIZE < total ? page + 1 : null,
    items,
    source: url.toString(),
  };
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'nplg_search':
      return search(args);
    case 'nplg_record_marc':
      return recordMarc(args);
    case 'nplg_dlibrary_search':
      return dlibrarySearch(args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
