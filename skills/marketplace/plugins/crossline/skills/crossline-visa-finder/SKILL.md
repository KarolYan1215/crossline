---
name: crossline-visa-finder
description: Find the official government page that says whether a citizen of one country needs a visa to visit another for a short event, and copy its sentences verbatim, including the one stating the processing time.
---

# Crossline Visa Finder

The answer decides whether an event abroad can still be reached: code opens every page given, finds each quote in the page's own text, and works the lead time out of the processing sentence itself. Nothing is taken on the answer's word, and a page that is not a government page is thrown away.

Accept `{version: "crossline.visa.v1", citizenship, destination, purpose}`:

- `citizenship`: the person's confirmed citizenship, as they wrote it.
- `destination`: the country the event is in.
- `purpose`: what the visit is for (a conference, a competition, a short programme), at most a few weeks.

Return raw JSON only: `{pages: [{url, needed, quote, processingQuote}]}`, at most three pages, most authoritative first.

## Finding

- Search the web. Use only pages run by a government: the destination's foreign ministry, immigration or consular service (`.gov`, `.gov.cn`, `.gouv.fr`, `.go.jp`, `.gc.ca`, `canada.ca`, `.admin.ch`, `europa.eu`, an embassy page on such a host). A visa agency, a travel site, a forum or an airline is never a source, whatever it says.
- `url`: the page you opened, https, exactly as opened.
- `needed`: `yes` when the page says a citizen of `citizenship` needs a visa (or an electronic authorization that must be approved) for this kind of short visit; `no` when it says they do not; `unknown` when the page does not settle it.
- `quote`: one sentence copied exactly from the page that settles `needed` (empty only for `unknown`).
- `processingQuote`: one sentence copied exactly from the page that states how long processing takes (「Applications are usually processed within 15 working days」, 「一般在 4 个工作日内办结」); empty when the page states none. Never write a number of days yourself: code reads it from this sentence.
- No official page found: `{pages: []}`. That is a valid answer; a guessed one is not.

| Case | `needed` | `quote` / `processingQuote` |
|---|---|---|
| Chinese citizen, Germany, a 3-day conference | yes | the Federal Foreign Office sentence requiring a Schengen visa / its processing sentence |
| German citizen, Japan, a week | no | the MOFA sentence on visa exemption / `""` |
| Page lists exemptions but not this nationality | unknown | `""` / `""` |

## Language

**Output language.** Quotes stay verbatim in the page's own language. There is no free text in this answer.
