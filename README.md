# Cursor Spend Pace

A Tampermonkey userscript for the [Cursor Spending](https://cursor.com/dashboard/spending) page. It marks **pace** (how far usage should have gone if you burned the quota evenly over the billing window), restores high-precision percentages the UI rounds away, and surfaces dollar caps when the APIs expose them — or infers them when they do not.

Install: [Greasy Fork](https://greasyfork.org/zh-CN/scripts/592140-cursor-spend-pace). Source: [github.com/xjoker/CursorSpendPace](https://github.com/xjoker/CursorSpendPace).

## What it solves

The Spending page only says something like “18% used”. It does not tell you:

- Where the quota *should* be by now on a linear burn
- How long to pause if you are ahead of pace
- How large each pool is in dollars (Cursor Models, Other Models, Grok Bot). The bar APIs often return percentages only.

The script runs in your logged-in `cursor.com` tab and reads the same origin APIs the dashboard already uses. No extra backend.

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/)
2. Open [Cursor Spend Pace on Greasy Fork](https://greasyfork.org/zh-CN/scripts/592140-cursor-spend-pace) and click Install
3. Open <https://cursor.com/dashboard/spending> and refresh

To install from this repo instead, create a new Tampermonkey script and paste [`cursor-spend-pace.user.js`](./cursor-spend-pace.user.js).

`@match` is `https://cursor.com/dashboard/*`. Overlay rendering is limited to the Spending path.

Version lives in the script header as `@version 20260820.7` (`YYYYMMDD.N`, reset `.N` each calendar day).

## What you will see

On each relevant bar:

- The top-right used label becomes the backend float, e.g. `18.422% used`
- A `|` marker on the track, with `↑ pace 11.64%` aligned under it
- Ahead of pace: `rest ~2d2h to even pace`
- Behind pace: `under pace · 36.12% left`

Quota line (only when data exists):

| Block | Meaning |
| --- | --- |
| Cursor Models | Dollars spent / cap. Uses `auto_limit` when the JSON includes it; otherwise **infers** `spent ÷ percent` and labels it `inferred` |
| Other Models | Included usage / included cap (`api_limit` first, else `includedAmountCents`) |
| Grok Bot | This week’s `sand-*` spend ÷ weekly percent; also labeled `inferred` |
| top … | Highest-spend model in that pool |

The script does not rewrite Cursor’s own copy (reset dates stay in the page locale). Overlay strings are English.

## How the Cursor Models cap is inferred

`PlanUsage` in the protobuf has `auto_limit` / `auto_spend`, but the HTTP JSON often omits them and only sends `autoPercentUsed`.

```text
cap ≈ Cursor Models spend this cycle ÷ (autoPercentUsed / 100)
```

Spend is the sum of `totalCents` from `POST /api/dashboard/get-aggregated-usage-events`. Membership in the Cursor Models pool follows `autoBucketModels`, plus **family matching** after stripping version and quality suffixes (so `grok-4.6` still matches a list that says `grok-4.5`). `sand-*` belongs to Grok Bot, not this pool.

When the quotient is within 1.5% of a round dollar amount, the script snaps to that round figure so you can compare caps across days. That value is inferred, not an official field.

The same spend÷percent trick does **not** apply to Other Models: list-price event cents and the included-usage percent often disagree. Other Models uses the official included cap only.

## Privacy

- `@grant none` — no extra Tampermonkey APIs
- Fetches stay on `cursor.com` with your existing session cookie
- Nothing is uploaded; the script does not write remote logs

Do not commit screenshots of your own Spending page (usage numbers and the account sidebar).

## Compatibility

- Accepts camelCase and snake_case fields
- Dates: ISO strings or epoch milliseconds
- Personal accounts send `teamId: -1`, same as the dashboard client; a real team id is used when the orgs/teams APIs return one
- Aggregated-usage requests retry two alternate bodies if the first fails
- Bars are identified by heading text, not by index
- Missing fields degrade: high-precision percent and pace still render; quota text says omitted instead of breaking the page

Cursor DOM or API changes can break the script until it is updated.

## License

MIT. The userscript header has `@license MIT` so Greasy Fork will display it; the full text is in [`LICENSE`](./LICENSE).

## Develop

Bump `@version` in the userscript header after behavior changes: `YYYYMMDD.N`. First publish of the day is `.1`, then increment. No build step.
