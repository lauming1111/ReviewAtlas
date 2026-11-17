# Review Atlas uninstall survey endpoint

A small Cloudflare Worker with a D1 database. The survey page (`docs/uninstall.html`) posts to it when
someone removes the extension and presses Send. It is a separate package: the extension build never
touches it.

- `POST /` stores one answer: the reasons picked, an optional note, the extension version and the UTC date.
- The caller's IP address is the rate-limit key (5 per minute) and nothing else. It is never stored or
  logged, and Workers observability is off in `wrangler.jsonc` on purpose.
- Only the origin in `ALLOWED_ORIGIN` may post. Everything else gets 403.

## Local development

```sh
cd survey-worker
npm install
npx wrangler types                      # regenerates worker-configuration.d.ts
npx tsc --noEmit
cp .dev.vars.example .dev.vars          # ALLOWED_ORIGIN=http://localhost:8000
npx wrangler d1 migrations apply review-atlas-survey --local
npx wrangler dev                        # http://localhost:8787
```

Serve the page with `python3 -m http.server 8000 --directory ../docs` and open
`http://localhost:8000/uninstall.html?v=1.5.0`.

## Deploy

Live at `https://review-atlas-survey.sortahub.workers.dev/`, which is the `ENDPOINT` in
`docs/uninstall.html`. The D1 database and its migration are already in place, so a code change
only needs:

```sh
cd survey-worker
npx wrangler deploy
```

If wrangler hangs after "Getting User settings" or with no output, set `CLOUDFLARE_ACCOUNT_ID` in
the shell. Its account lookup can stall, and the id skips it.

New migrations go out with `npx wrangler d1 migrations apply review-atlas-survey --remote`.

Check the live Worker with the page's real origin:

```sh
curl -i -X POST https://review-atlas-survey.sortahub.workers.dev/ \
  -H 'Origin: https://lauming1111.github.io' -H 'Content-Type: text/plain' \
  --data '{"reasons":["other"],"note":"deploy check","v":"1.5.0"}'
```

Expect `204`. Delete that test row afterwards (see below).

## Reading the answers

```sh
npx wrangler d1 execute review-atlas-survey --remote \
  --command "SELECT id, created_on, version, reasons, note FROM responses ORDER BY id DESC LIMIT 50"
```

Reason counts:

```sh
npx wrangler d1 execute review-atlas-survey --remote \
  --command "SELECT j.value AS reason, COUNT(*) AS n FROM responses, json_each(responses.reasons) j GROUP BY j.value ORDER BY n DESC"
```

Delete a row: `... --command "DELETE FROM responses WHERE id = 1"`.

## Reasons

The allow-list lives in `src/index.ts` (`REASONS`) and as the checkboxes in `docs/uninstall.html`.
Change both together.
