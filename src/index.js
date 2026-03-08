// Import local copy of non-browser Turndown (browser build needs native DOM)
import TurndownService from './turndown.js';

const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-',
});

const LLMS_POST_LIMIT = 25;

// Convert Ghost image cards
turndown.addRule('ghostImage', {
  filter(node) {
    return node.nodeName === 'FIGURE' && node.classList.contains('kg-image-card');
  },
  replacement(content, node) {
    const img = node.querySelector('img');
    const figcaption = node.querySelector('figcaption');
    if (!img) return content;
    const alt = figcaption ? figcaption.textContent.trim() : (img.alt || '');
    const src = img.getAttribute('src') || '';
    return `\n![${alt}](${src})\n`;
  },
});

// Convert Ghost bookmark cards
turndown.addRule('ghostBookmark', {
  filter(node) {
    return node.nodeName === 'FIGURE' && node.classList.contains('kg-bookmark-card');
  },
  replacement(content, node) {
    const link = node.querySelector('a.kg-bookmark-container');
    const title = node.querySelector('.kg-bookmark-title');
    if (!link) return content;
    const href = link.getAttribute('href') || '';
    const text = title ? title.textContent.trim() : href;
    return `\n[${text}](${href})\n`;
  },
});

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/llms.txt') {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return new Response('Method not allowed', {
          status: 405,
          headers: { 'Allow': 'GET, HEAD' },
        });
      }

      return handleLlmsTxtRequest(request, url, env, ctx);
    }

    // Check if request is for a .md file
    if (url.pathname.endsWith('.md')) {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return new Response('Method not allowed', {
          status: 405,
          headers: { 'Allow': 'GET, HEAD' },
        });
      }

      return handleMarkdownRequest(request, url, env, ctx);
    }

    // For all other requests, pass through to origin and inject alternate link
    return handleHtmlPassthrough(request, url);
  },
};

async function handleLlmsTxtRequest(request, url, env, ctx) {
  const ghostApiKey = env.GHOST_API_KEY;
  const ghostUrl = env.GHOST_URL || url.origin;

  if (!ghostApiKey) {
    return new Response('GHOST_API_KEY not configured', { status: 500 });
  }

  const cacheKey = new Request(url.toString(), { method: 'GET' });
  const cache = caches.default;
  const cachedResponse = await cache.match(cacheKey);
  if (cachedResponse) {
    return asHeadResponseIfNeeded(request, cachedResponse);
  }

  const [settings, posts] = await Promise.all([
    fetchGhostJson(
      `${ghostUrl}/ghost/api/content/settings/?key=${ghostApiKey}`,
      '/llms.txt',
      'Ghost settings'
    ),
    fetchGhostJson(
      `${ghostUrl}/ghost/api/content/posts/?key=${ghostApiKey}&limit=${LLMS_POST_LIMIT}`,
      '/llms.txt',
      'Ghost post index'
    ),
  ]);

  if (settings.error) {
    return settings.error;
  }

  if (posts.error) {
    return posts.error;
  }

  const site = settings.data.settings || {};
  const recentPosts = posts.data.posts || [];
  const siteTitle = site.title || url.hostname;
  const siteDescription = site.description || `Published Ghost posts from ${url.hostname}`;

  const lines = [
    `# ${siteTitle}`,
    '',
    `> ${siteDescription}`,
    '',
    'This site exposes published Ghost posts as Markdown by appending `.md` to post URLs.',
    '',
    '## Recent posts',
  ];

  if (recentPosts.length === 0) {
    lines.push('', 'No published posts were returned by the Ghost Content API.');
  } else {
    for (const post of recentPosts) {
      const markdownUrl = buildMarkdownUrlForPost(post, url.origin);
      if (!markdownUrl) {
        continue;
      }

      const summary = post.custom_excerpt || post.excerpt;
      const summaryText = summary ? `: ${sanitizeText(summary)}` : '';
      lines.push(`- [${post.title}](${markdownUrl})${summaryText}`);
    }
  }

  const response = new Response(`${lines.join('\n')}\n`, {
    status: 200,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'public, max-age=300, s-maxage=300, stale-while-revalidate=60',
    },
  });

  ctx.waitUntil(cache.put(cacheKey, response.clone()));
  return asHeadResponseIfNeeded(request, response);
}

async function handleMarkdownRequest(request, url, env, ctx) {
  // Extract slug: /some/path/my-post.md -> my-post
  const pathSegments = url.pathname.split('/');
  const filename = pathSegments[pathSegments.length - 1];
  const slug = filename.replace(/\.md$/, '');

  if (!slug) {
    return new Response('Missing slug', { status: 400 });
  }

  const ghostApiKey = env.GHOST_API_KEY;
  const ghostUrl = env.GHOST_URL || url.origin;

  if (!ghostApiKey) {
    return new Response('GHOST_API_KEY not configured', { status: 500 });
  }

  const cacheKey = new Request(url.toString(), { method: 'GET' });
  const cache = caches.default;
  const cachedResponse = await cache.match(cacheKey);
  if (cachedResponse) {
    return asHeadResponseIfNeeded(request, cachedResponse);
  }

  // Fetch post from Ghost Content API
  const apiUrl = `${ghostUrl}/ghost/api/content/posts/slug/${slug}/?key=${ghostApiKey}&formats=html&include=tags`;

  let apiResponse;
  try {
    apiResponse = await fetch(apiUrl, {
      headers: { 'Accept': 'application/json' },
    });
  } catch (err) {
    console.error('Ghost API fetch failed', {
      path: url.pathname,
      error: formatError(err),
    });
    return new Response('Upstream unavailable', { status: 502 });
  }

  if (!apiResponse.ok) {
    if (apiResponse.status === 404) {
      return new Response(`Post not found: ${slug}`, { status: 404 });
    }
    return new Response(`Ghost API error: ${apiResponse.status}`, { status: apiResponse.status });
  }

  const data = await apiResponse.json();
  const post = data.posts?.[0];

  if (!post) {
    return new Response(`Post not found: ${slug}`, { status: 404 });
  }

  // Build YAML frontmatter
  const tags = (post.tags || []).map((t) => t.name);
  const canonicalUrl = post.url || `${ghostUrl}/${slug}/`;
  const publishedDate = post.published_at ? post.published_at.split('T')[0] : '';

  const frontmatter = [
    '---',
    `title: "${escapeYaml(post.title)}"`,
    `date: ${publishedDate}`,
    `tags: [${tags.map((t) => `"${escapeYaml(t)}"`).join(', ')}]`,
    `canonical_url: "${canonicalUrl}"`,
    '---',
  ].join('\n');

  // Convert HTML to Markdown
  const markdown = turndown.turndown(post.html || '');

  const body = `${frontmatter}\n\n${markdown}\n`;

  const response = new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Cache-Control': 'public, max-age=300, s-maxage=300, stale-while-revalidate=60',
    },
  });

  ctx.waitUntil(cache.put(cacheKey, response.clone()));
  return asHeadResponseIfNeeded(request, response);
}

async function handleHtmlPassthrough(request, url) {
  let response;
  try {
    // Pass request through to origin
    response = await fetch(request);
  } catch (err) {
    console.error('Origin fetch failed', {
      path: url.pathname,
      error: formatError(err),
    });
    return new Response('Upstream unavailable', { status: 502 });
  }

  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('text/html')) {
    return response;
  }

  // Build the .md alternate URL from the current path
  // e.g. /my-post/ -> /my-post.md
  const mdUrl = buildMdUrl(url);

  if (!mdUrl) {
    return response;
  }

  // Use HTMLRewriter to inject <link rel="alternate"> into <head>
  return new HTMLRewriter()
    .on('head', {
      element(element) {
        element.append(
          `<link rel="alternate" type="text/markdown" href="${mdUrl}" />`,
          { html: true }
        );
      },
    })
    .transform(response);
}

function buildMdUrl(url) {
  let path = url.pathname;

  // Remove trailing slash
  if (path.endsWith('/') && path.length > 1) {
    path = path.slice(0, -1);
  }

  if (path === '/' || path === '') {
    return null;
  }

  const segments = path.split('/').filter(Boolean);
  if (segments.length === 0) {
    return null;
  }

  const firstSegment = segments[0];
  const lastSegment = segments[segments.length - 1];

  // Skip Ghost internals, collection routes, and existing file paths.
  if (
    firstSegment === 'ghost' ||
    firstSegment === 'assets' ||
    firstSegment === 'content' ||
    path.match(/\.\w+$/) ||
    lastSegment === 'rss'
  ) {
    return null;
  }

  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    const nextSegment = segments[index + 1];

    if ((segment === 'tag' || segment === 'author') && nextSegment) {
      return null;
    }

    if (segment === 'page' && nextSegment && /^\d+$/.test(nextSegment)) {
      return null;
    }
  }

  return `${url.origin}${path}.md`;
}

function escapeYaml(str) {
  if (!str) return '';
  return str.replace(/"/g, '\\"');
}

async function fetchGhostJson(apiUrl, requestPath, targetName) {
  let apiResponse;

  try {
    apiResponse = await fetch(apiUrl, {
      headers: { 'Accept': 'application/json' },
    });
  } catch (err) {
    console.error(`${targetName} fetch failed`, {
      path: requestPath,
      error: formatError(err),
    });
    return {
      error: new Response('Upstream unavailable', { status: 502 }),
    };
  }

  if (!apiResponse.ok) {
    return {
      error: new Response(`${targetName} error: ${apiResponse.status}`, { status: apiResponse.status }),
    };
  }

  return {
    data: await apiResponse.json(),
  };
}

function asHeadResponseIfNeeded(request, response) {
  if (request.method !== 'HEAD') {
    return response;
  }

  return new Response(null, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function formatError(err) {
  return err instanceof Error ? err.message : String(err);
}

function buildMarkdownUrlForPost(post, publicOrigin) {
  const canonicalUrl = post.url || `${publicOrigin}/${post.slug}/`;

  try {
    const parsedUrl = new URL(canonicalUrl);
    let path = parsedUrl.pathname;

    if (path.endsWith('/') && path.length > 1) {
      path = path.slice(0, -1);
    }

    return `${parsedUrl.origin}${path}.md`;
  } catch {
    return null;
  }
}

function sanitizeText(str) {
  return str.replace(/\s+/g, ' ').trim();
}
