# Meta Ad Library Monitor MCP Server

[![Smithery](https://smithery.ai/badge/mambabuilt/mcp-meta-ad-library-monitor)](https://smithery.ai/servers/mambabuilt/mcp-meta-ad-library-monitor) [![Glama score](https://glama.ai/mcp/servers/mambalabsdev/mcp-meta-ad-library-monitor/badges/score.svg)](https://glama.ai/mcp/servers/mambalabsdev/mcp-meta-ad-library-monitor) [![MCP Registry](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fregistry.modelcontextprotocol.io%2Fv0%2Fservers%3Fsearch%3Dcom.mambabuilt%252Fmcp-meta-ad-library-monitor%26limit%3D1&query=%24.servers%5B0%5D._meta%5B%22io.modelcontextprotocol.registry%2Fofficial%22%5D.status&label=mcp%20registry&color=blue)](https://registry.modelcontextprotocol.io/v0/servers?search=com.mambabuilt/mcp-meta-ad-library-monitor&limit=1) [![npm version](https://img.shields.io/npm/v/@mambalabsdev/mcp-meta-ad-library-monitor)](https://www.npmjs.com/package/@mambalabsdev/mcp-meta-ad-library-monitor) [![npm downloads](https://img.shields.io/npm/dm/@mambalabsdev/mcp-meta-ad-library-monitor)](https://www.npmjs.com/package/@mambalabsdev/mcp-meta-ad-library-monitor) [![license](https://img.shields.io/github/license/mambalabsdev/mcp-meta-ad-library-monitor)](https://github.com/mambalabsdev/mcp-meta-ad-library-monitor/blob/main/LICENSE) [![mcpservers.org](https://img.shields.io/badge/mcpservers.org-listed-blue)](https://mcpservers.org/servers/mambalabsdev/mcp-meta-ad-library-monitor)

An MCP server that finds a company's active Facebook and Instagram ads through the Meta Ad Library API. It wraps the Mamba Labs Meta Ad Library Monitor actor on Apify and returns Clay-ready flat JSON rows to any MCP client.

## What's Inside

- [What it does](#what-it-does)
- [Quick start](#quick-start)
- [Prerequisites](#prerequisites)
- [Example prompts](#example-prompts)
- [Inputs](#inputs)
- [Output](#output)
- [Example output](#example-output)
- [Features](#features)
- [Full actor documentation](#full-actor-documentation)
- [Mamba Labs GTM Suite](#mamba-labs-gtm-suite)
- [License](#license)

## What it does

Give it a company name or domain and your own Meta access token, and it searches the Meta Ad Library and returns one flat row per ad: creative text, headline, delivery dates, the Meta surfaces the ad ran on, and Meta's permanent snapshot URL for the rendered ad.

Read the coverage first, because it decides whether this tool is any use to you. It reads Meta's Ad Library Graph API, which is the only route Meta sanctions, and that API publishes two things: every ad delivered to an audience in the EU, whatever the ad is about, and social issue, election and politics ads worldwide. So an EU heavy list gets good coverage of ordinary commercial advertising, while a US or UK list of ordinary product ads mostly comes back `not_found`. That is Meta's dataset rather than a fault in the lookup, and every row carries a coverage note saying what the search could have found. Impressions and spend exist for political ads only and arrive as bands, so a null there is not zero spend.

All of the searching runs on Apify. This package is a thin client that calls the actor and hands back the result unchanged.

## Quick start

You need Node.js 18 or newer and an Apify account with an API token.

Add this to your Claude Desktop config:

```json
{
  "mcpServers": {
    "mamba-meta-ad-library-monitor": {
      "command": "npx",
      "args": ["-y", "@mambalabsdev/mcp-meta-ad-library-monitor"],
      "env": {
        "APIFY_TOKEN": "your-apify-token"
      }
    }
  }
}
```

Get your token at https://console.apify.com/account/integrations, paste it in, and restart Claude Desktop. The `find_meta_ads` tool will be available.

You also need your own Meta app access token, free to create at developers.facebook.com. It is passed as a tool argument rather than an environment variable, so the model supplies it per call.

## Prerequisites

- Node.js 18 or newer
- An Apify account with an API token
- Your own Meta app access token, free at developers.facebook.com. The Ad Library API is not open, so this is required.
- A verified identity on your Meta account if you want political and issue ad data. That is Meta's requirement, not ours.

## Example prompts

- "Is gymshark.com running Facebook ads in the EU right now? Here is my Meta token."
- "Show me the last 25 active ads for this company across EU audiences."
- "Find video ads only for this advertiser, active and inactive."
- "Search the Meta Ad Library for this brand in the UK and tell me what the coverage note says."

## Inputs

- `company_domain` (optional): bare company domain, for example `gymshark.com`. Used to derive the advertiser search term when no company name is given, and used by the identity gate to check that a matched advertiser page really is this company.
- `company_name` (optional but strongly recommended): Meta advertiser search is a fuzzy text search over page names, so the company name is what the identity gate compares a matched page against. Without it the gate falls back to the domain stem, which is weaker.
- `metaAccessToken` (optional in the schema, required in practice): your own Meta app access token, free to create at developers.facebook.com. The Ad Library API is not open, so a search without one cannot run.
- `ad_reached_countries` (optional): which country audiences to search. One of `EU`, `GB`, `US`, `DE`, `FR`, `NL`, `ES`, `IT`, `IE` or `ALL_EU_PLUS_UK`. Meta requires this parameter and a request without it fails outright. The EU set is where the Ad Library covers all ads rather than only political ones, so it is the default.
- `ad_active_status` (optional): `ACTIVE`, `ALL` or `INACTIVE`. `ACTIVE` is the default because a currently running ad is the buying signal. `ALL` is what you want for a creative history or a competitive teardown.
- `ad_type` (optional): `ALL` returns every ad the Ad Library holds for those countries. `POLITICAL_AND_ISSUE_ADS` narrows to the political archive, which is the only archive carrying impressions and spend and which requires a verified identity on your Meta account.
- `media_type` (optional): `ALL`, `IMAGE`, `VIDEO`, `MEME` or `NONE`. Useful for a creative teardown where you only care about video.
- `maxAds` (optional): how many ad rows to return per company. One of `10`, `25`, `50` or `100`. This is a cost dial, not a change of answer: the row always reports how many ads matched before the cap.
- `skipCache` (optional): when false (the default) a successful lookup is cached for seven days and reused. Set true to force a fresh fetch.

## Output

The tool returns the actor's flat JSON rows, one per ad, in snake_case with no nested objects. `advertiser_match` says how the advertiser page was matched and `advertisers_rejected` counts the ones the identity gate turned away. `coverage_note` states what the search could have found, so an empty result is readable. `impressions` and `spend` are populated for political and issue ads only. See the Apify Store page for the full output schema.

## Example output

```json
{
  "degraded": false,
  "degradation_reason": null,
  "company_domain": "gymshark.com",
  "company_name": "Gymshark",
  "page_id": "102590181603009",
  "page_name": "Gymshark Women",
  "advertiser_match": "name_match",
  "advertisers_rejected": 9,
  "ad_id": "2824771397896004",
  "ad_creative_body": "Hol dir die soften, leichten Gymsets fürs Training (und den chaotischen Alltag) ✨",
  "ad_creative_link_title": "Everyday Seamless ab 30 € 💸",
  "ad_creation_time": "2026-08-21",
  "ad_delivery_start_time": "2026-08-21",
  "ad_delivery_stop_time": null,
  "ad_snapshot_url": "https://www.facebook.com/ads/library/?id=2824771397896004",
  "publisher_platforms": "facebook, instagram, audience_network, messenger, threads",
  "languages": "de",
  "impressions": null,
  "spend": null,
  "currency": null,
  "ads_matched": 10,
  "coverage_note": "Searched EU audiences, where the Ad Library covers all ads, plus non EU audiences where it covers only political and issue ads. A commercial advertiser outside the EU is legitimately absent.",
  "coverage": 1,
  "fetch_status": "ok",
  "run_date": "2026-08-23T05:50:09.867Z"
}
```

## Features

- One flat row per ad, with creative text, headline and delivery dates
- Meta's own permanent snapshot URL for each rendered ad
- The Meta surfaces an ad ran on, in `publisher_platforms`
- Reads Meta's sanctioned Ad Library Graph API and no other route
- A coverage note on every row, so an empty result is readable
- Advertiser identity gate, with rejected candidates counted

## Full actor documentation

This server is a thin client and holds no search logic. For the complete input and output reference, pricing, and run history, see the Apify Store page:

https://apify.com/mambalabs/meta-ad-library-monitor

---

## Mamba Labs GTM Suite

This server is one of the Mamba Labs GTM Suite MCP servers. Every actor in the suite takes a domain or a company and returns one flat row, so they stack in the same Clay table without reshaping anything. The actor behind this server is the Meta Ad Library Monitor, immutable Apify actor ID `J1GWlSXfSGU3u8Wng`.

> Built by [Mamba Labs](https://github.com/mambalabsdev) | [npm](https://www.npmjs.com/org/mambalabsdev) | [Apify Store](https://apify.com/mambalabs)

## License

MIT

Built by Mamba Labs. https://apify.com/mambalabs
