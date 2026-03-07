# Ghost Markdown Worker

A Cloudflare Worker that lets anyone download any post on your [Ghost](https://ghost.org) blog as a clean Markdown file -- just change the URL extension to `.md`.

```
https://yourblog.com/my-post/     <- normal HTML post
https://yourblog.com/my-post.md   <- same post as Markdown
```

The returned Markdown includes YAML frontmatter with title, date, tags, and canonical URL, ready for static site generators, note-taking apps, or archiving.

## How It Works

The worker sits between visitors and your Ghost blog via Cloudflare's network:

![Architecture diagram showing two flows: .md requests are intercepted by the Cloudflare Worker which fetches from Ghost Content API, converts HTML to Markdown and returns text/markdown. Regular HTML requests pass through to Ghost and the worker injects a link alternate tag.](docs/architecture.png)

For regular page visits, it passes the request through to Ghost unchanged, but injects a `<link rel="alternate" type="text/markdown">` tag so browsers and tools can discover the Markdown version.

### Technical Note: Turndown in Workers

Cloudflare Workers don't have a native DOM, but the [Turndown](https://github.com/mixmark-io/turndown) library's browser build requires `document` and `DOMParser`. This project uses a local copy of Turndown's Node.js build (`src/turndown.js`) which relies on [@mixmark-io/domino](https://github.com/mixmark-io/domino) for DOM parsing instead. The `nodejs_compat` compatibility flag is required in `wrangler.toml` to support this.

## Prerequisites

- **A Ghost blog** -- self-hosted (e.g. on [Cloudron](https://www.cloudron.io/store/com.ghost.cloudronapp.html), Docker, etc.) or Ghost(Pro)
- **A Cloudflare account** (free plan works) with your blog's domain added
- **Node.js** v18 or later
- **npm** (comes with Node.js)

---

## Step 1: Set Up a Ghost Integration

The worker uses Ghost's **Content API** (read-only) to fetch posts. You need to create an integration to get an API key.

1. Log in to your Ghost Admin panel at `https://yourblog.com/ghost/`
2. Go to **Settings** (gear icon in the bottom-left)
3. Scroll down to **Advanced** and click **Integrations**
4. Click **Add custom integration**
5. Give it a name (e.g. `Markdown Worker`)
6. Click **Add**
7. Copy the **Content API Key** -- you'll need it in Step 4

> The Content API key is read-only. It can only read published posts, so it's safe to use in a worker.

## Step 2: Proxy Your Domain Through Cloudflare

Your blog's domain must be routed through Cloudflare so the worker can intercept requests.

### If your domain is NOT on Cloudflare yet

1. Sign up at [cloudflare.com](https://www.cloudflare.com/)
2. Click **Add a site** and enter your domain
3. Select the **Free** plan (or any plan)
4. Cloudflare will scan your existing DNS records. Verify they look correct
5. Update your domain's nameservers at your registrar to the ones Cloudflare provides
6. Wait for nameserver propagation (usually a few minutes, can take up to 24 hours)

### If your domain is already on Cloudflare

Make sure the DNS record pointing to your Ghost server has the **orange cloud** (Proxied) enabled, not "DNS only". This is required for the worker to run.

### Cloudron-specific note

If Ghost is hosted on Cloudron, your setup likely looks like this:

- **Public domain:** `yourblog.com` (what visitors see)
- **Cloudron origin:** `ghost.yourdomain.com` or the same domain

The Cloudflare DNS record for your public domain should point to your Cloudron server's IP with proxy (orange cloud) enabled. The worker will use `GHOST_URL` to reach the Ghost API at the correct origin -- see Step 3.

## Step 3: Configure the Worker

Clone this repo and install dependencies:

```bash
git clone https://github.com/YOUR_USERNAME/ghost-markdown-worker.git
cd ghost-markdown-worker
npm install
```

Edit `wrangler.toml`:

```toml
name = "ghost-markdown-worker"
main = "src/index.js"
compatibility_date = "2024-12-01"
compatibility_flags = ["nodejs_compat"]

# Route the worker on your Ghost blog's domain.
# Replace with your actual domain:
routes = [{ pattern = "yourblog.com/*", zone_name = "yourblog.com" }]

[vars]
# The URL where Ghost is actually reachable.
# If Ghost is on the same domain, you can omit this.
# If Ghost is behind Cloudron or a reverse proxy, set the origin URL:
GHOST_URL = "https://yourblog.com"
```

**`compatibility_flags`** -- `nodejs_compat` is required because the HTML-to-Markdown conversion uses [domino](https://github.com/mixmark-io/domino) for DOM parsing, which relies on Node.js APIs.

**`routes`** -- tells Cloudflare which domain/path this worker should handle. Use your blog's public domain.

**`GHOST_URL`** -- the origin URL where Ghost's API is accessible. This is important if:
- Ghost runs on a subdomain (`https://ghost.example.com`) but your blog is at `example.com`
- Ghost is behind Cloudron or another reverse proxy
- In most cases, this is the same as your public blog URL

## Step 4: Deploy

First, log in to Cloudflare via Wrangler (opens a browser window):

```bash
npx wrangler login
```

Set your Ghost Content API key as an encrypted secret:

```bash
npx wrangler secret put GHOST_API_KEY
```

Paste the Content API key you copied from Ghost in Step 1 when prompted.

Deploy the worker:

```bash
npm run deploy
```

That's it! Your worker is live. Test it:

```bash
curl https://yourblog.com/any-post-slug.md
```

## Step 5: Configure Caching and Rate Limiting

### Caching

Successful `.md` responses are already cached by the Worker at the edge using Cloudflare's Workers Cache API.

- No extra dashboard cache rule is required for the basic setup
- The current Worker response headers cache Markdown for 5 minutes and allow a short stale window while a fresh copy is generated
- This cache is per Cloudflare data center, so the first `.md` request in a new region may still hit Ghost
- Cache API behavior only works on your proxied custom domain, not in the Workers editor or Playground preview

If you want a longer or shorter cache window, change the `Cache-Control` header in `src/index.js`.

### Rate Limiting

Caching should handle normal repeat traffic. Add one Cloudflare rate limiting rule as a backstop for abusive `.md` downloads.

In the Cloudflare dashboard:

1. Open your zone
2. Go to **Security** > **WAF** > **Rate limiting rules**
3. Create a rule for Markdown downloads
4. Match requests using either the expression editor or equivalent UI fields:

```txt
(http.request.method in {"GET" "HEAD"} and http.request.uri.path ends_with ".md")
```

Recommended starting settings:

- **Action:** `Managed Challenge`
- **Requests:** `60`
- **Period:** `1 minute`
- **Characteristics:** keep the default per-visitor/IP behavior from the dashboard

If you want to observe traffic before enforcing, start with `Log` first, then change the action to `Managed Challenge` after checking Security Events.

Cloudflare plan limits and dashboard labels can vary. If your plan exposes extra controls such as whether cached assets are counted, keep the configuration simple unless you have measured traffic that requires tuning.

---

## Local Development

Create a `.dev.vars` file in the project root with your secrets:

```
GHOST_API_KEY=your_content_api_key_here
GHOST_URL=https://yourblog.com
```

> `.dev.vars` is already in `.gitignore` -- never commit this file.

Start the dev server:

```bash
npm run dev
```

Wrangler will start a local server (usually at `http://localhost:8787`). Test with:

```bash
curl http://localhost:8787/my-post.md
```

## Output Format

### Frontmatter

Every Markdown file includes YAML frontmatter:

```yaml
---
title: "My Blog Post Title"
date: 2024-06-15
tags: ["javascript", "cloudflare", "ghost"]
canonical_url: "https://yourblog.com/my-blog-post-title/"
---
```

### Ghost-Specific Conversions

The worker handles Ghost's custom HTML cards:

| Ghost Card | Markdown Output |
|---|---|
| Image card (`kg-image-card`) | `![caption](url)` |
| Bookmark card (`kg-bookmark-card`) | `[Title](url)` |
| Code blocks with language | Fenced code blocks with language identifier |
| Standard HTML | Converted via [Turndown](https://github.com/mixmark-io/turndown) |

### Alternate Link Injection

On regular HTML pages, the worker injects a discovery tag in `<head>`:

```html
<link rel="alternate" type="text/markdown" href="https://yourblog.com/my-post.md" />
```

The worker preserves nested post paths, so `/notes/my-post/` advertises `/notes/my-post.md`.

This is skipped for the homepage, Ghost admin pages, Ghost asset paths (`/assets/`, `/content/`), collection pages such as `/tag/...` and `/author/...`, pagination paths like `/page/2/`, and existing file paths.

## Troubleshooting

### "GHOST_API_KEY not configured"

You haven't set the secret yet. Run:

```bash
npx wrangler secret put GHOST_API_KEY
```

### "Post not found: my-post"

- Check that the post is **published** (drafts aren't available via Content API)
- Check that the slug matches exactly -- visit your post in Ghost Admin and check the URL slug in post settings

### Worker not intercepting requests

- Make sure your DNS record in Cloudflare is set to **Proxied** (orange cloud), not DNS-only
- Verify the `routes` pattern in `wrangler.toml` matches your domain
- Check the worker is deployed: `npx wrangler deployments list`

### "document is not defined" or 1101 errors

This means the worker is using Turndown's browser build instead of the Node.js build. Make sure:
- `src/turndown.js` exists (the local copy of the Node.js build)
- `src/index.js` imports from `'./turndown.js'`, not from `'turndown'`
- `compatibility_flags = ["nodejs_compat"]` is set in `wrangler.toml`

### Wrong content or API errors

- Verify `GHOST_URL` points to the correct origin where Ghost is running
- Test the Content API directly: `curl "https://yourblog.com/ghost/api/content/posts/?key=YOUR_KEY&limit=1"`
- Check worker logs: `npx wrangler tail`

## License

MIT
