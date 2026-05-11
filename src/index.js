import { ADMIN_HTML } from './html.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // 你的博客索引地址
    const JSON_URL = 'https://blogo.ccwu.cc/posts-index.json';

    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    // =========================
    // 页面路由
    // =========================
    if (
      path === '/' ||
      path === '/admin' ||
      path === '/new' ||
      path === '/list' ||
      path === '/gallery' ||
      path === '/settings' ||
      path.startsWith('/edit/')
    ) {
      return new Response(ADMIN_HTML, {
        headers: {
          'Content-Type': 'text/html',
        },
      });
    }

    // =========================
    // 图片代理
    // =========================
    if (path.startsWith('/image/') || path.startsWith('/img/')) {
      const isPhotoRepo = path.startsWith('/img/');

      const filename = isPhotoRepo
        ? path.replace('/img/', '')
        : path.replace('/image/', '');

      const encodedPath = filename
        .split('/')
        .map(encodeURIComponent)
        .join('/');

      const imageUrl = isPhotoRepo
        ? `https://raw.githubusercontent.com/ImUpXuu/photo/main/images/${encodedPath}`
        : `https://raw.githubusercontent.com/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/${env.GITHUB_BRANCH}/${env.IMAGE_PATH}/${encodedPath}`;

      return await proxyImage(imageUrl, env.GITHUB_TOKEN);
    }

    // =========================
    // API
    // =========================
    if (path.startsWith('/api/')) {
      const authHeader = request.headers.get('Authorization');

      if (
        !authHeader ||
        authHeader !== `Bearer ${env.ADMIN_PASSWORD}`
      ) {
        return new Response('Unauthorized', {
          status: 401,
          headers: corsHeaders,
        });
      }

      const apiPath = path.replace('/api', '');

      // =========================================
      // 获取文章列表
      // 极速 JSON 索引 + GraphQL 递归保底
      // =========================================
      if (
        (apiPath === '/posts' || apiPath === '/list') &&
        request.method === 'GET'
      ) {
        try {
          const indexRes = await fetch(JSON_URL, {
            cf: {
              cacheTtl: 60,
            },
          });

          if (indexRes.ok) {
            const indexData = await indexRes.json();

            const formatted = indexData.map((post) => ({
              name: post.path.split('/').pop(),
              path: post.path, // 保留完整路径
              title: post.title || '',
              category: post.category || '',
              date: post.date || '',
              sha: 'static-placeholder',
              type: 'file',
            }));

            formatted.sort(
              (a, b) =>
                new Date(b.date || 0) -
                new Date(a.date || 0)
            );

            return new Response(
              JSON.stringify(formatted),
              {
                headers: {
                  ...corsHeaders,
                  'Content-Type':
                    'application/json',
                  'X-Source': 'Static-JSON',
                },
              }
            );
          }
        } catch (e) {
          console.error(
            'Static JSON failed, fallback GraphQL',
            e
          );
        }

        // JSON失败 -> 回退递归扫描
        return await listGitHubFilesRecursive(
          env,
          env.POSTS_PATH
        );
      }

      // =========================================
      // 图片库列表
      // =========================================
      if (
        apiPath === '/images' &&
        request.method === 'GET'
      ) {
        return await listPhotoImagesRecursive(env);
      }

      // =========================================
      // 上传图片
      // =========================================
      if (
        apiPath === '/upload' &&
        request.method === 'POST'
      ) {
        const body = await request.json();

        return await uploadToPhotoRepo(
          env,
          body.filename,
          body.content,
          url.origin
        );
      }

      // =========================================
      // 单文章操作
      // =========================================
      if (
        apiPath.startsWith('/post/') &&
        (
          request.method === 'GET' ||
          request.method === 'PUT' ||
          request.method === 'DELETE'
        )
      ) {
        const filename = decodeURIComponent(
          apiPath.replace('/post/', '')
        );

        const realPath =
          await resolveRealPostPath(
            env,
            filename,
            JSON_URL
          );

        // GET
        if (request.method === 'GET') {
          return await getGitHubFile(
            env,
            realPath
          );
        }

        // PUT
        if (request.method === 'PUT') {
          const body = await request.json();

          let sha = body.sha;

          // 静态索引没有真实 sha
          if (
            !sha ||
            sha === 'static-placeholder'
          ) {
            const check =
              await githubRequest(
                env,
                realPath
              );

            if (check.ok) {
              const fileData =
                await check.json();

              sha = fileData.sha;
            }
          }

          return await updateGitHubFile(
            env,
            realPath,
            body.content,
            sha,
            `Update ${filename} via Admin`
          );
        }

        // DELETE
        if (request.method === 'DELETE') {
          const body = await request.json();

          return await deleteGitHubFile(
            env,
            realPath,
            body.sha,
            `Delete ${filename}`
          );
        }
      }

      // =========================================
      // 设置管理
      // =========================================
      if (apiPath === '/settings') {
        // GET
        if (request.method === 'GET') {
          return await getSettings(env);
        }

        // PUT
        if (request.method === 'PUT') {
          const body = await request.json();

          const target =
            body.file === 'config'
              ? 'src/config.ts'
              : 'src/layouts/Layout.astro';

          return await updateGitHubFile(
            env,
            target,
            body.content,
            body.sha,
            'Update settings via Admin'
          );
        }
      }
    }

    return new Response('Not Found', {
      status: 404,
    });
  },
};

// =====================================================
// 图片代理
// =====================================================

async function proxyImage(url, token) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Blog-Admin',
      Authorization: `Bearer ${token}`,
    },
  });

  if (!res.ok) {
    return new Response('Not found', {
      status: 404,
    });
  }

  const headers = new Headers();

  headers.set(
    'Access-Control-Allow-Origin',
    '*'
  );

  headers.set(
    'Cache-Control',
    'public, max-age=31536000'
  );

  const contentType =
    res.headers.get('Content-Type');

  if (contentType) {
    headers.set(
      'Content-Type',
      contentType
    );
  }

  return new Response(res.body, {
    status: res.status,
    headers,
  });
}

// =====================================================
// GraphQL 递归文章扫描
// =====================================================

async function listGitHubFilesRecursive(
  env,
  postsPath
) {
  const query = `
    query($owner: String!, $repo: String!, $path: String!) {
      repository(owner: $owner, name: $repo) {
        object(expression: $path) {
          ... on Tree {
            entries {
              name
              type
              oid
              object {
                ... on Blob {
                  text
                }
              }
            }
          }
        }
      }
    }
  `;

  async function scan(currentPath) {
    const res = await fetch(
      'https://api.github.com/graphql',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.GITHUB_TOKEN}`,
          'User-Agent': 'Blog-Admin',
          'Content-Type':
            'application/json',
        },
        body: JSON.stringify({
          query,
          variables: {
            owner: env.GITHUB_OWNER,
            repo: env.GITHUB_REPO,
            path: `${env.GITHUB_BRANCH}:${currentPath}`,
          },
        }),
      }
    );

    const data = await res.json();

    const entries =
      data?.data?.repository?.object
        ?.entries || [];

    let results = [];

    for (const entry of entries) {
      const fullPath =
        `${currentPath}/${entry.name}`;

      // 目录
      if (entry.type === 'tree') {
        results.push(
          ...(await scan(fullPath))
        );
      }

      // md文件
      else if (
        entry.type === 'blob' &&
        entry.name.endsWith('.md')
      ) {
        let title = entry.name;
        let date = '';

        // Frontmatter解析
        const fm =
          entry.object?.text?.match(
            /^---\n([\s\S]*?)\n---/
          );

        if (fm) {
          const titleMatch =
            fm[1].match(
              /^title:\s*(["']?)(.*)\1$/m
            );

          const dateMatch =
            fm[1].match(
              /^published:\s*(.*)$/m
            );

          if (titleMatch) {
            title =
              titleMatch[2].trim();
          }

          if (dateMatch) {
            date =
              dateMatch[1].trim();
          }
        }

        results.push({
          name: entry.name,
          path: fullPath.replace(
            `${env.POSTS_PATH}/`,
            ''
          ),
          fullPath,
          title,
          date,
          sha: entry.oid,
          type: 'file',
        });
      }
    }

    return results;
  }

  const files = await scan(postsPath);

  files.sort(
    (a, b) =>
      new Date(b.date || 0) -
      new Date(a.date || 0)
  );

  return new Response(
    JSON.stringify(files),
    {
      headers: {
        'Content-Type':
          'application/json',
      },
    }
  );
}

// =====================================================
// GraphQL 递归图片扫描
// =====================================================

async function listPhotoImagesRecursive(
  env
) {
  const query = `
    query($owner: String!, $repo: String!, $path: String!) {
      repository(owner: $owner, name: $repo) {
        object(expression: $path) {
          ... on Tree {
            entries {
              name
              type
              oid
            }
          }
        }
      }
    }
  `;

  async function scan(currentPath) {
    const res = await fetch(
      'https://api.github.com/graphql',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.GITHUB_TOKEN}`,
          'User-Agent': 'Blog-Admin',
          'Content-Type':
            'application/json',
        },
        body: JSON.stringify({
          query,
          variables: {
            owner: 'ImUpXuu',
            repo: 'photo',
            path: `main:${currentPath}`,
          },
        }),
      }
    );

    const data = await res.json();

    const entries =
      data?.data?.repository?.object
        ?.entries || [];

    let results = [];

    for (const entry of entries) {
      const fullPath =
        `${currentPath}/${entry.name}`;

      // 目录递归
      if (entry.type === 'tree') {
        results.push(
          ...(await scan(fullPath))
        );
      }

      // 图片
      else if (
        /\.(jpg|jpeg|png|gif|webp|svg)$/i.test(
          entry.name
        )
      ) {
        const relativePath =
          fullPath.replace(
            /^images\//,
            ''
          );

        results.push({
          name: entry.name,
          path: relativePath,
          sha: entry.oid,
          url: `/img/${relativePath}`,
        });
      }
    }

    return results;
  }

  const images = await scan('images');

  return new Response(
    JSON.stringify(images),
    {
      headers: {
        'Content-Type':
          'application/json',
      },
    }
  );
}

// =====================================================
// 图片上传（严格版）
// =====================================================

async function uploadToPhotoRepo(
  env,
  filename,
  content,
  origin
) {
  const encodedPath = filename
    .split('/')
    .map(encodeURIComponent)
    .join('/');

  const url = `https://api.github.com/repos/ImUpXuu/photo/contents/images/${encodedPath}`;

  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      'User-Agent': 'Blog-Admin',
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept:
        'application/vnd.github.v3+json',
    },
    body: JSON.stringify({
      message: `Upload ${filename}`,
      content,
      branch: 'main',
    }),
  });

  const data = await res.json();

  if (!res.ok) {
    return new Response(
      JSON.stringify({
        error:
          data.message ||
          'Upload failed',
      }),
      {
        status: res.status,
        headers: {
          'Content-Type':
            'application/json',
        },
      }
    );
  }

  return new Response(
    JSON.stringify({
      url: `${origin}/img/${filename}`,
    }),
    {
      headers: {
        'Content-Type':
          'application/json',
      },
    }
  );
}

// =====================================================
// 解析真实文章路径
// =====================================================

async function resolveRealPostPath(
  env,
  filename,
  jsonUrl
) {
  try {
    const res = await fetch(jsonUrl);

    if (res.ok) {
      const data = await res.json();

      const match = data.find((p) =>
        p.path.endsWith(filename)
      );

      if (match) {
        return `src/content/posts/${match.path}`;
      }
    }
  } catch (e) {
    console.error(
      'Resolve path failed',
      e
    );
  }

  return `${env.POSTS_PATH}/${filename}`;
}

// =====================================================
// GitHub API 基础函数
// =====================================================

async function githubRequest(
  env,
  path,
  method = 'GET',
  body = null
) {
  const encodedPath = path
    .split('/')
    .map(encodeURIComponent)
    .join('/');

  const url = `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/${encodedPath}?ref=${env.GITHUB_BRANCH}`;

  const options = {
    method,
    headers: {
      'User-Agent': 'Blog-Admin',
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept:
        'application/vnd.github.v3+json',
    },
  };

  if (body) {
    options.body = JSON.stringify(body);
  }

  return await fetch(url, options);
}

// =====================================================
// 获取文件
// =====================================================

async function getGitHubFile(env, path) {
  const res = await githubRequest(
    env,
    path
  );

  if (!res.ok) {
    return res;
  }

  const data = await res.json();

  const binary = atob(
    data.content.replace(/\n/g, '')
  );

  const raw =
    new TextDecoder('utf-8').decode(
      Uint8Array.from(binary, (c) =>
        c.charCodeAt(0)
      )
    );

  return new Response(
    JSON.stringify({
      content: raw,
      sha: data.sha,
    }),
    {
      headers: {
        'Content-Type':
          'application/json',
      },
    }
  );
}

// =====================================================
// 更新文件（UTF-8安全）
// =====================================================

async function updateGitHubFile(
  env,
  path,
  content,
  sha,
  message
) {
  const uint8 =
    new TextEncoder().encode(content);

  const base64 = btoa(
    String.fromCharCode(...uint8)
  );

  const body = {
    message,
    content: base64,
    branch: env.GITHUB_BRANCH,
  };

  if (
    sha &&
    sha !== 'static-placeholder'
  ) {
    body.sha = sha;
  }

  const res = await githubRequest(
    env,
    path,
    'PUT',
    body
  );

  return new Response(
    JSON.stringify(await res.json()),
    {
      status: res.status,
    }
  );
}

// =====================================================
// 删除文件
// =====================================================

async function deleteGitHubFile(
  env,
  path,
  sha,
  message
) {
  const res = await githubRequest(
    env,
    path,
    'DELETE',
    {
      message,
      sha,
      branch: env.GITHUB_BRANCH,
    }
  );

  return new Response(
    JSON.stringify(await res.json()),
    {
      status: res.status,
    }
  );
}

// =====================================================
// 获取设置文件
// =====================================================

async function getSettings(env) {
  const configRes =
    await githubRequest(
      env,
      'src/config.ts'
    );

  const layoutRes =
    await githubRequest(
      env,
      'src/layouts/Layout.astro'
    );

  const configJson =
    await configRes.json();

  const layoutJson =
    await layoutRes.json();

  const decode = (data) => {
    const binary = atob(
      data.content.replace(/\n/g, '')
    );

    return new TextDecoder(
      'utf-8'
    ).decode(
      Uint8Array.from(binary, (c) =>
        c.charCodeAt(0)
      )
    );
  };

  return new Response(
    JSON.stringify({
      config: {
        content: decode(configJson),
        sha: configJson.sha,
      },
      layout: {
        content: decode(layoutJson),
        sha: layoutJson.sha,
      },
    }),
    {
      headers: {
        'Content-Type':
          'application/json',
      },
    }
  );
}