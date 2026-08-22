#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8"));
// Distinctive UA so Apify run meta.userAgent marks MCP-originated runs.
const USER_AGENT = `mambalabs-mcp ${pkg.name}@${pkg.version}`;
const APIFY_TOKEN = process.env.APIFY_TOKEN;
// Drop undefined values so optional inputs are not sent to the actor at all.
function compact(obj) {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
        if (v !== undefined)
            out[k] = v;
    }
    return out;
}
// The actor types its switches as strings ("true"/"false") for Clay
// compatibility, because Clay sends every input as a string and a boolean typed
// field silently receives "false" and reads it as truthy. The model gets a real
// boolean and the actor gets the string it validates.
function boolToString(v) {
    return v === undefined ? undefined : v ? "true" : "false";
}
// actorPath is the actor's IMMUTABLE Apify actor id, not its slug, so a Store
// rename never breaks these calls.
async function runActor(actorPath, actorLabel, input) {
    if (!APIFY_TOKEN) {
        return { isError: true, content: [{ type: "text", text: "APIFY_TOKEN is not set. Create a token at https://console.apify.com/account/integrations and set it as the APIFY_TOKEN environment variable." }] };
    }
    // memory=512 is deliberate and matches the actor's declared
    // defaultRunOptions.memoryMbytes. run-sync-get-dataset-items runs at 2048 MB
    // unless told otherwise, and `apify-actor-start` bills once per GB with a
    // minimum of one, so leaving the default in place would charge the caller
    // more start events per run than the actor asks for. Keep this in step with
    // the actor's defaultRunOptions.
    const url = `https://api.apify.com/v2/acts/${actorPath}/run-sync-get-dataset-items?timeout=300&memory=512`;
    let response;
    try {
        response = await fetch(url, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${APIFY_TOKEN}`,
                "Content-Type": "application/json",
                "User-Agent": USER_AGENT,
            },
            body: JSON.stringify(input),
        });
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { isError: true, content: [{ type: "text", text: `Could not reach the Apify API: ${message}` }] };
    }
    if (!response.ok) {
        let detail = "";
        try {
            const body = (await response.json());
            if (body?.error?.message)
                detail = ` ${body.error.message}`;
        }
        catch {
            detail = "";
        }
        let message;
        switch (response.status) {
            case 401:
                message = "Invalid Apify token. Check your APIFY_TOKEN environment variable.";
                break;
            case 402:
                message = "Insufficient Apify credits. Check your account balance at https://console.apify.com/billing";
                break;
            case 408:
                message = `The ${actorLabel} run timed out after 300 seconds. Try again, or run the actor on Apify directly for longer jobs.`;
                break;
            default:
                message = `Apify request to ${actorLabel} failed with status ${response.status}.${detail}`;
        }
        return { isError: true, content: [{ type: "text", text: message }] };
    }
    // A 2xx normally carries the dataset array. Pass actor output through
    // unchanged: the wrapper must never reinterpret a status field, because
    // not_extractable, blocked and not_found are different answers and collapsing
    // them is exactly the defect the actor was built to avoid.
    const items = await response.json();
    return { content: [{ type: "text", text: JSON.stringify(items, null, 2) }] };
}
const server = new McpServer({
    name: "mamba-meta-ad-library-monitor",
    version: pkg.version,
});
// Meta Ad Library Monitor (immutable actor ID J1GWlSXfSGU3u8Wng)
server.registerTool("find_meta_ads", {
    title: "Find Meta Ads",
    description: "Search the Meta Ad Library for a company's ads through Facebook's sanctioned Graph API and return ONE FLAT ROW PER AD with creative text, headline, delivery dates, the Meta surfaces it ran on and Meta's permanent snapshot URL for the rendered ad. COVERAGE IS NOT UNIVERSAL: the Ad Library holds all ads only in the EU and only political and issue ads elsewhere, so a commercial advertiser outside the EU is legitimately absent and every row carries a coverage note saying what the search could have found. Requires the CALLER's own Meta app access token. Impressions and spend exist for political ads only and arrive as bands, so a null there is not zero spend. Read only; requires an APIFY_TOKEN and consumes Apify credits per call.",
    annotations: {
        title: "Find Meta Ads",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
    },
    inputSchema: {
        company_domain: z.string()
            .optional()
            .describe("Bare company domain, for example gymshark.com. Used to derive the advertiser search term when no company name is given, and used by the identity gate to check that a matched advertiser page really is this company."),
        company_name: z.string()
            .optional()
            .describe("Strongly recommended here. Meta advertiser search is a fuzzy text search over page names, so the company name is what the identity gate compares a matched page against. Without it the gate falls back to the domain stem, which is weaker."),
        metaAccessToken: z.string()
            .optional()
            .describe("YOUR OWN Meta app access token, free to create at developers.facebook.com. REQUIRED: the Ad Library API is not open. Political and issue ad data additionally requires a verified identity on your Meta account, which is Meta requirement and not ours. Marked secret, so the value never renders on this page."),
        ad_reached_countries: z.enum(["EU", "GB", "US", "DE", "FR", "NL", "ES", "IT", "IE", "ALL_EU_PLUS_UK"])
            .optional()
            .describe("Which country audiences to search. This parameter is REQUIRED by Meta and a request without it fails outright. The EU set is where the Ad Library covers ALL ads rather than only political ones, so it is the default. Sent as a string for Clay compatibility."),
        ad_active_status: z.enum(["ACTIVE", "ALL", "INACTIVE"])
            .optional()
            .describe("Whether to return currently running ads, stopped ads, or both. ACTIVE is the default because a currently running ad is the buying signal; ALL is what you want for a creative history or a competitive teardown. Sent as a string for Clay compatibility."),
        ad_type: z.enum(["ALL", "POLITICAL_AND_ISSUE_ADS"])
            .optional()
            .describe("ALL returns every ad the Ad Library holds for those countries. POLITICAL_AND_ISSUE_ADS narrows to the political archive, which is the only archive that carries impressions and spend, and which requires a verified identity on your Meta account. Sent as a string for Clay compatibility."),
        media_type: z.enum(["ALL", "IMAGE", "VIDEO", "MEME", "NONE"])
            .optional()
            .describe("Narrow to a creative format. Useful for a creative teardown where you only care about video, and irrelevant for a simple \"are they advertising\" check. Sent as a string for Clay compatibility."),
        maxAds: z.enum(["10", "25", "50", "100"])
            .optional()
            .describe("How many ad rows to return per company. This is a cost dial, not a change of answer: the row always reports how many ads matched before the cap. Sent as a string for Clay compatibility."),
        skipCache: z.boolean()
            .optional()
            .describe("When \"false\" (default) a successful lookup is cached for seven days and reused, which costs you nothing on a repeated run. Set \"true\" to force a fresh fetch. Sent as a string for Clay compatibility."),
    },
}, async ({ company_domain, company_name, metaAccessToken, ad_reached_countries, ad_active_status, ad_type, media_type, maxAds, skipCache }) => {
    return runActor("J1GWlSXfSGU3u8Wng", "Meta Ad Library Monitor", compact({
        company_domain,
        company_name,
        metaAccessToken,
        ad_reached_countries,
        ad_active_status,
        ad_type,
        media_type,
        maxAds,
        skipCache: boolToString(skipCache),
    }));
});
const transport = new StdioServerTransport();
await server.connect(transport);
