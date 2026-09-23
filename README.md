# @pipeworx/nplg-catalog

The union catalogue and the digital library of the National Parliamentary Library
of Georgia — Georgian bibliographic records with their MARC intact, plus a small
full-text digital collection.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1663+ live data sources.

## Tools

- `nplg_search(query, index?, scope?, offset?)` — search the union catalogue by
  keyword / title / author / subject. Returns a **true** total (not a page count)
  plus 50 brief citations, each with its permanent Sierra `bib_id`, title
  (Georgian with the parallel Latin title split out where the record carries
  one), author, imprint, material type and a stable catalogue URL. `scope` 1-11
  narrows by material — books, periodicals, maps, dissertations, archival
  documents, newspaper and journal articles.
- `nplg_record_marc(bib_id)` — one record as parsed MARC: leader, control fields,
  and every data field with its indicators and subfields kept **separate**, plus
  a flattened summary (title, authors, imprint, languages, classification,
  subjects, host item). The 041 language codes and the parallel Georgian/English
  245 survive as structure rather than as one string.
- `nplg_dlibrary_search(query, collection?, page?)` — the digital library: scanned
  print archive, dissertations and posters, each hit with authors, date of issue,
  a full source citation, subject headings in Georgian/Russian/English, a Dewey
  subject and a stable item URL.

## Auth

Keyless. Every request answers without a credential.

A Sierra REST API v6.1.0 **is** live at `catalog.nplg.gov.ge/iii/sierra-api/v6/`
and 401s without a library-issued client key/secret (OAuth2 client credentials,
exchanged at `/v6/token`). Asking NPLG for one would turn every HTML parse in
this pack into a supported JSON API and change nothing else about its shape.

## Data sources

- <https://catalog.nplg.gov.ge/search*eng/X?SEARCH=…&searchscope=1&SORT=D> — the
  union catalogue, Innovative Interfaces Sierra behind the classic WebPAC Pro
  front end (`Server: III 100`).
- `https://catalog.nplg.gov.ge/search~S<scope>*eng?/X<q>…/<first>%2C<total>%2C<total>%2CB/browse`
  — III's native offset cursor.
- <https://catalog.nplg.gov.ge/search*eng/.b4972685/.b4972685/1%2C1%2C1%2CB/marc>
  — per-record MARC, `|` as the subfield delimiter.
- <http://www.nplg.gov.ge/dlibrary/search.html?qs=…&co=0&pg=1> — the digital
  library. `co` is the collection (0 all, 1 print archive, 2 dissertations,
  3 posters), `pg` the 1-based page of 10.

## Things the next person would otherwise rediscover the hard way

**The phrase indexes do not return records.** `/search*eng/t`, `/a` and `/d`
answer 200 with an alphabetical list of *headings* and zero brief citations — a
title search that looks like it returned nothing. Records come from the keyword
index with III's own field qualifier inside the query: `t:(tbilisi)`,
`a:(abashidze)`, `d:(tbilisi)`. That is what `index:` does here.

**The offset cursor carries the result total in the URL, and lying to it still
returns rows.** The `51,2896,2896,B` triple is `first,last,total`. Pass a total
that is not the search's and you still get a 200 with records, under a header
reporting a total that belongs to nothing — a page that is right about the rows
and wrong about the size of what it is paging through. So an offset request
reads the real total from the first page before asking for the offset; it costs
one extra request and is the only way to page honestly.

**The `~S<scope>` in the cursor path must match `searchscope=`.** They are the
same number in two places and the path one is what actually scopes the browse.

**Georgian arrives as numeric character references.** Most of the markup is
`&#4315;` rather than UTF-8, and MARC punctuation comes through as `&#59;` /
`&#34;`. An entity decoder that only knows `&amp;` and friends returns mojibake
that still parses cleanly.

**A no-hit search is a 200 carrying "NO ENTRIES FOUND"** plus a did-you-mean
block, never a 404. The pack reports `total: 0` with a note; anything else that
parses to zero records is raised as an error, because a silently empty list is
indistinguishable from a layout change.

**Brief citations have one or two citation lines, and one means no author.**
A record without a 100 field shows only its imprint, so reading the first line
as the author gets you "თბილისი, 2023." filed as a person.

**MARC column positions are load-bearing.** Tag 0-2, indicators 4-5, data from 7,
wrapped lines indented 7. Any tag-stripping that substitutes a space shifts the
columns and every field comes out one character wrong.

**`/search*geo` labels the MARC leader `ლიდერი` and the result header in
Georgian**; `/search*eng` says `LEADER` and `Keywords (1-50 of 2896)`. The
records are identical either way, so the pack asks for the English interface
purely so the labels are stable.

## Dead ends, so nobody re-walks them

- `dspace.nplg.gov.ge` — a DSpace instance that would ship OAI-PMH and a REST
  API if it were up. It returned 503 from Apache on every path on 2026-09-10
  morning and **404 from Apache** on every path (`/`, `/rest/communities`,
  `/server/api`, `/oai/request?verb=Identify`, `/jspui/`) when re-probed the same
  day. Still no application behind the web server; the failure just changed
  shape. Worth re-probing before anyone assumes the digital-library half of this
  pack is as good as it gets.
- `www.nplg.gov.ge/ec/ka/*` — the older electronic catalogue, 403.
- `geoclassic.nplg.gov.ge` — a WooCommerce shop for Georgian classical music. It
  does expose `wp-json`, but it is a store, not a catalogue.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "nplg-catalog": {
      "url": "https://gateway.pipeworx.io/nplg-catalog/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/nplg-catalog/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1663+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/nplg_search \
  -H 'Content-Type: application/json' \
  -d '{"query":"tbilisi"}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/nplg_search`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

```json
{
  "mcpServers": {
    "nplg-catalog": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-nplg-catalog"]
    }
  }
}
```

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-nplg-catalog
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Nplg Catalog data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
