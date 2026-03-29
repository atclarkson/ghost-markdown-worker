// Import local copy of non-browser Turndown (browser build needs native DOM)
import TurndownService from './turndown.js';

const LLMS_POST_LIMIT = 25;
const MARKDOWN_CONTENT_TYPE = 'text/markdown; charset=utf-8';
const MARKDOWN_CACHE_CONTROL = 'public, max-age=300, s-maxage=300, stale-while-revalidate=60';
const MARKDOWN_CACHE_BUSTER = '__gmw_repr=markdown';

const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-',
});

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

    const requestMode = classifyRequest(request, url);
    if (requestMode.kind === 'markdown') {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return new Response('Method not allowed', {
          status: 405,
          headers: { 'Allow': 'GET, HEAD' },
        });
      }

      return handleMarkdownRequest(request, url, env, ctx, requestMode);
    }

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
    'This site exposes published Ghost posts as Markdown by appending `.md` to post URLs or by sending `Accept: text/markdown` to the HTML URL.',
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
      lines.push(`- [${escapeMarkdownLinkText(post.title)}](${markdownUrl})${summaryText}`);
    }
  }

  const response = new Response(`${lines.join('\n')}\n`, {
    status: 200,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': MARKDOWN_CACHE_CONTROL,
    },
  });

  ctx.waitUntil(cache.put(cacheKey, response.clone()));
  return asHeadResponseIfNeeded(request, response);
}

async function handleMarkdownRequest(request, url, env, ctx, requestMode) {
  const pathSegments = requestMode.htmlPath.split('/');
  const slug = pathSegments[pathSegments.length - 1];

  if (!slug) {
    return new Response('Missing slug', { status: 400 });
  }

  const ghostApiKey = env.GHOST_API_KEY;
  const ghostUrl = env.GHOST_URL || url.origin;

  if (!ghostApiKey) {
    return new Response('GHOST_API_KEY not configured', { status: 500 });
  }

  const postResult = await fetchGhostJson(
    `${ghostUrl}/ghost/api/content/posts/slug/${slug}/?key=${ghostApiKey}&formats=html&include=authors,tags`,
    url.pathname,
    'Ghost post lookup'
  );

  if (postResult.error) {
    if (postResult.status === 404) {
      return new Response(`Post not found: ${slug}`, { status: 404 });
    }

    return postResult.error;
  }

  const post = postResult.data.posts?.[0];
  if (!post) {
    return new Response(`Post not found: ${slug}`, { status: 404 });
  }

  const canonicalUrl = post.url || `${ghostUrl}/${slug}/`;
  let canonicalPath;
  try {
    canonicalPath = normalizePathname(new URL(canonicalUrl).pathname);
  } catch (err) {
    console.error('Invalid canonical URL from Ghost', {
      path: url.pathname,
      canonicalUrl,
      error: formatError(err),
    });
    return new Response('Invalid canonical URL', { status: 502 });
  }

  if (requestMode.htmlPath !== canonicalPath) {
    return new Response('Canonical URL mismatch', { status: 404 });
  }

  const cache = caches.default;
  const cacheKey = createMarkdownCacheKey(url, canonicalPath);
  const cachedResponse = await cache.match(cacheKey);
  if (cachedResponse) {
    return asHeadResponseIfNeeded(request, cachedResponse);
  }

  const settingsResult = await fetchGhostJson(
    `${ghostUrl}/ghost/api/content/settings/?key=${ghostApiKey}`,
    url.pathname,
    'Ghost settings'
  );

  const settings = settingsResult.error ? null : settingsResult.data.settings || null;
  const tags = (post.tags || []).map((tag) => tag.name);
  const publishedDate = post.published_at ? post.published_at.split('T')[0] : '';
  const description = post.meta_description || post.custom_excerpt || post.excerpt || '';
  const author = post.primary_author?.name || '';
  const lang = settings?.lang || '';

  const frontmatter = [
    '---',
    `title: "${escapeYaml(post.title)}"`,
    `slug: "${escapeYaml(post.slug || '')}"`,
    `description: "${escapeYaml(description)}"`,
    `author: "${escapeYaml(author)}"`,
    `lang: "${escapeYaml(lang)}"`,
    `date: ${publishedDate ? `"${escapeYaml(publishedDate)}"` : '""'}`,
    `published_at: "${escapeYaml(post.published_at || '')}"`,
    `updated_at: "${escapeYaml(post.updated_at || '')}"`,
    `feature_image: "${escapeYaml(post.feature_image || '')}"`,
    `tags: [${tags.map((tag) => `"${escapeYaml(tag)}"`).join(', ')}]`,
    `canonical_url: "${escapeYaml(canonicalUrl)}"`,
    '---',
  ].join('\n');

  const markdown = turndown.turndown(post.html || '');
  const body = `${frontmatter}\n\n${markdown}\n`;
  const response = new Response(body, {
    status: 200,
    headers: {
      'Content-Type': MARKDOWN_CONTENT_TYPE,
      'Cache-Control': MARKDOWN_CACHE_CONTROL,
      'Vary': 'Accept',
    },
  });

  ctx.waitUntil(cache.put(cacheKey, response.clone()));
  return asHeadResponseIfNeeded(request, response);
}

async function handleHtmlPassthrough(request, url) {
  let response;
  try {
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

  const mdUrl = buildMdUrl(url);
  if (!mdUrl) {
    return response;
  }

  if (request.method === 'HEAD') {
    return addAlternateMarkdownHeaders(response, mdUrl);
  }

  const rewritten = new HTMLRewriter()
    .on('head', {
      element(element) {
        element.append(
          `<link rel="alternate" type="text/markdown" href="${mdUrl}" />`,
          { html: true }
        );
      },
    })
    .transform(response);

  return addAlternateMarkdownHeaders(rewritten, mdUrl);
}

function classifyRequest(request, url) {
  if (url.pathname.endsWith('.md')) {
    return {
      kind: 'markdown',
      htmlPath: buildHtmlPathFromMarkdownPath(url.pathname),
    };
  }

  if (acceptsMarkdown(request.headers.get('Accept')) && buildMdUrl(url)) {
    return {
      kind: 'markdown',
      htmlPath: normalizePathname(url.pathname),
    };
  }

  return { kind: 'html' };
}

function buildHtmlPathFromMarkdownPath(pathname) {
  return normalizePathname(pathname.replace(/\.md$/, ''));
}

function buildMdUrl(url) {
  let path = url.pathname;

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

function createMarkdownCacheKey(url, canonicalPath) {
  const cacheUrl = new URL(url.toString());
  cacheUrl.pathname = canonicalPath;
  cacheUrl.search = `?${MARKDOWN_CACHE_BUSTER}`;
  cacheUrl.hash = '';
  return new Request(cacheUrl.toString(), { method: 'GET' });
}

function addAlternateMarkdownHeaders(response, mdUrl) {
  const headers = new Headers(response.headers);
  headers.append('Link', `<${mdUrl}>; rel="alternate"; type="text/markdown"`);
  addVaryValue(headers, 'Accept');

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function addVaryValue(headers, value) {
  const vary = headers.get('Vary');
  if (!vary) {
    headers.set('Vary', value);
    return;
  }

  const existing = vary
    .split(',')
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);

  if (!existing.includes(value.toLowerCase())) {
    headers.set('Vary', `${vary}, ${value}`);
  }
}

function normalizePathname(pathname) {
  if (!pathname || pathname === '/') {
    return '/';
  }

  return pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
}

function acceptsMarkdown(acceptHeader) {
  if (!acceptHeader) {
    return false;
  }

  return acceptHeader
    .split(',')
    .map((part) => part.trim())
    .some((part) => {
      const [mediaType, ...params] = part.split(';').map((item) => item.trim());
      if (mediaType.toLowerCase() !== 'text/markdown') {
        return false;
      }

      const qParam = params.find((param) => param.toLowerCase().startsWith('q='));
      if (!qParam) {
        return true;
      }

      const qValue = Number.parseFloat(qParam.slice(2));
      return Number.isFinite(qValue) && qValue > 0;
    });
}

function escapeYaml(str) {
  if (!str) return '';
  return str
    .replace(/\\/g, '\\\\')
    .replace(/\r?\n/g, '\\n')
    .replace(/"/g, '\\"');
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
      status: 502,
    };
  }

  if (!apiResponse.ok) {
    return {
      error: new Response(`${targetName} error: ${apiResponse.status}`, { status: apiResponse.status }),
      status: apiResponse.status,
    };
  }

  return {
    data: await apiResponse.json(),
    status: apiResponse.status,
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
    return buildMarkdownUrlFromPath(parsedUrl.pathname, parsedUrl.origin);
  } catch {
    return null;
  }
}

function buildMarkdownUrlFromPath(pathname, origin) {
  const normalizedPath = normalizePathname(pathname);
  if (normalizedPath === '/') {
    return null;
  }

  return `${origin}${normalizedPath}.md`;
}

function sanitizeText(str) {
  return str.replace(/\s+/g, ' ').trim();
}

function escapeMarkdownLinkText(str) {
  return String(str).replace(/([\\[\]])/g, '\\$1');
}
