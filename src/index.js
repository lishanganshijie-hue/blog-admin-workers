import { ADMIN_HTML } from './html.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    
    // 1. 跨域头设置
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    // 2. 路由控制：访问后台界面
    if (path === '/' || path === '/admin' || path === '/new' || path === '/list' || path === '/gallery' || path === '/settings' || path.startsWith('/edit/')) {
      return new Response(ADMIN_HTML, {
        headers: { 'Content-Type': 'text/html' },
      });
    }

    // 3. 图像代理逻辑 (Public Access)
    if (path.startsWith('/image/') || path.startsWith('/img/')) {
        const isNewRepo = path.startsWith('/img/');
        const filename = isNewRepo ? path.replace('/img/', '') : path.replace('/image/', '');
        
        let imageUrl;
        if (isNewRepo) {
            const PHOTO_PATH = 'images';
            const encodedPath = filename.split('/').map(encodeURIComponent).join('/');
            imageUrl = `https://raw.githubusercontent.com/ImUpXuu/photo/main/${PHOTO_PATH}/${encodedPath}`;
        } else {
            imageUrl = `https://raw.githubusercontent.com/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/${env.GITHUB_BRANCH}/${env.IMAGE_PATH}/${filename}`;
        }

        const imageRes = await fetch(imageUrl, {
            headers: {
                'User-Agent': 'Cloudflare-Worker-Blog-Admin',
                'Authorization': `Bearer ${env.GITHUB_TOKEN}`
            }
        });

        if (!imageRes.ok) return new Response('Image not found', { status: 404 });

        const newHeaders = new Headers(imageRes.headers);
        newHeaders.set('Access-Control-Allow-Origin', '*');
        newHeaders.set('Cache-Control', 'public, max-age=31536000');

        return new Response(imageRes.body, { status: imageRes.status, headers: newHeaders });
    }

    // 4. API 接口逻辑
    if (path.startsWith('/api/')) {
      // 鉴权
      const authHeader = request.headers.get('Authorization');
      if (!authHeader || authHeader !== `Bearer ${env.ADMIN_PASSWORD}`) {
        return new Response('Unauthorized', { status: 401, headers: corsHeaders });
      }

      const apiPath = path.replace('/api', '');

      // --- [核心优化] 获取文章列表 ---
      if ((apiPath === '/posts' || apiPath === '/list') && request.method === 'GET') {
        const staticIndexUrl = `https://upxuu.com/posts-index.json`;
        try {
          const indexRes = await fetch(staticIndexUrl, { 
            headers: { 'User-Agent': 'Cloudflare-Worker-FastFetch' },
            cf: { cacheTtl: 60 } // 让 Cloudflare 缓存这个索引 1 分钟，进一步加速
          });

          if (indexRes.ok) {
            const indexData = await indexRes.json();
            // --- 替换为这个 ---
            const formatted = indexData.map(post => {
              const fileName = post.path.split('/').pop();
              return {
                name: fileName,
                // 🟢 重点：直接使用文件名作为 path，或者保持和 JSON 一致
                // 很多后台前端逻辑是通过文件名来匹配的
                path: fileName, 
                title: post.title,
                category: post.category,
                date: post.date || null,
                sha: "static-index-placeholder", // 🟢 给一个占位符，防止前端因缺少 sha 而报错
                type: 'file',
                fullPath: `src/content/posts/${post.path}` // 留一个完整路径备用
              };
            });
            // 按日期排序
            formatted.sort((a, b) => (b.date && a.date) ? new Date(b.date) - new Date(a.date) : 0);
            return new Response(JSON.stringify(formatted), { 
              headers: { ...corsHeaders, 'Content-Type': 'application/json', 'X-Source': 'Static-Index' } 
            });
          }
        } catch (e) { 
          console.error("Index fetch failed, falling back...", e); 
        }
        // 保底逻辑
        return await listGitHubFiles(env, env.POSTS_PATH);
      }

      // 获取单篇文章内容
      if (apiPath.startsWith('/post/') && request.method === 'GET') {
        const filename = decodeURIComponent(apiPath.replace('/post/', ''));
        return await getGitHubFile(env, `${env.POSTS_PATH}/${filename}`);
      }

      // 创建或更新文章
      if (apiPath.startsWith('/post/') && request.method === 'PUT') {
        const filename = decodeURIComponent(apiPath.replace('/post/', ''));
        const body = await request.json();
        let sha = body.sha;
        if (!sha) {
          const checkRes = await githubRequest(env, `${env.POSTS_PATH}/${filename}`);
          if (checkRes.ok) { sha = (await checkRes.json()).sha; }
        }
        return await updateGitHubFile(env, `${env.POSTS_PATH}/${filename}`, body.content, sha, `Update ${filename} via Admin`);
      }

      // 删除文章
      if (apiPath.startsWith('/post/') && request.method === 'DELETE') {
        const filename = decodeURIComponent(apiPath.replace('/post/', ''));
        const body = await request.json();
        return await deleteGitHubFile(env, `${env.POSTS_PATH}/${filename}`, body.sha, `Delete ${filename} via Admin`);
      }

      // 获取图片库列表 (photo 仓库)
      if (apiPath === '/images' && request.method === 'GET') {
        return await listPhotoImages(env);
      }

      // 上传图片 (photo 仓库)
      if (apiPath === '/upload' && request.method === 'POST') {
        const body = await request.json();
        return await uploadPhotoImage(env, body.filename, body.content, url.origin);
      }

      // 删除图片 (photo 仓库)
      if (apiPath.startsWith('/img/') && request.method === 'DELETE') {
        const filename = decodeURIComponent(apiPath.replace('/img/', ''));
        const body = await request.json();
        return await deletePhotoImage(env, filename, body.sha);
      }

      // 获取/更新博客配置 (config.ts / Layout.astro)
      if (apiPath === '/settings') {
        if (request.method === 'GET') return await getSettings(env);
        if (request.method === 'PUT') {
          const body = await request.json();
          const targetPath = body.file === 'config' ? 'src/config.ts' : 'src/layouts/Layout.astro';
          return await updateGitHubFile(env, targetPath, body.content, body.sha, `Update ${body.file} via Admin`);
        }
      }
    }

    return new Response('Not Found', { status: 404 });
  },
};

// --- 辅助执行函数 ---

async function githubRequest(env, path, method = 'GET', body = null) {
  const encodedPath = path.split('/').map(encodeURIComponent).join('/');
  const url = `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/${encodedPath}?ref=${env.GITHUB_BRANCH}`;
  const headers = {
    'User-Agent': 'Cloudflare-Worker-Blog-Admin',
    'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
    'Accept': 'application/vnd.github.v3+json',
  };
  const options = { method, headers };
  if (body) options.body = JSON.stringify(body);
  return await fetch(url, options);
}

async function getGitHubFile(env, path) {
  const res = await githubRequest(env, path);
  if (!res.ok) return res;
  const data = await res.json();
  const content = atob(data.content.replace(/\n/g, ''));
  const decoder = new TextDecoder('utf-8');
  return new Response(JSON.stringify({
    content: decoder.decode(Uint8Array.from(content, c => c.charCodeAt(0))),
    sha: data.sha
  }), { headers: { 'Content-Type': 'application/json' } });
}

async function updateGitHubFile(env, path, content, sha, message) {
  const encoder = new TextEncoder();
  const uint8Array = encoder.encode(content);
  let binaryString = '';
  for (let i = 0; i < uint8Array.length; i++) binaryString += String.fromCharCode(uint8Array[i]);
  const base64Content = btoa(binaryString);
  const body = { message, content: base64Content, branch: env.GITHUB_BRANCH };
  if (sha) body.sha = sha;
  const res = await githubRequest(env, path, 'PUT', body);
  return new Response(JSON.stringify(await res.json()), { status: res.status });
}

async function deleteGitHubFile(env, path, sha, message) {
    const body = { message, sha, branch: env.GITHUB_BRANCH };
    const res = await githubRequest(env, path, 'DELETE', body);
    return new Response(JSON.stringify(await res.json()), { status: res.status });
}

// --- 图片库专属函数 (photo 仓库) ---

async function listPhotoImages(env) {
  const res = await fetch(`https://api.github.com/repos/ImUpXuu/photo/contents/images?ref=main`, {
    headers: {
      'User-Agent': 'Cloudflare-Worker-Blog-Admin',
      'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
      'Accept': 'application/vnd.github.v3+json',
    }
  });
  const data = await res.json();
  if (!res.ok) return new Response(JSON.stringify(data), { status: res.status });
  const images = data.filter(f => f.type === 'file' && /\.(jpg|jpeg|png|gif|webp|svg)$/i.test(f.name)).map(f => ({
    name: f.name, path: f.path, sha: f.sha, url: `/img/${f.name}`
  }));
  return new Response(JSON.stringify(images), { headers: { 'Content-Type': 'application/json' } });
}

async function uploadPhotoImage(env, filename, content, origin) {
  const path = `images/${filename}`;
  const encodedPath = path.split('/').map(encodeURIComponent).join('/');
  const url = `https://api.github.com/repos/ImUpXuu/photo/contents/${encodedPath}?ref=main`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      'User-Agent': 'Cloudflare-Worker-Blog-Admin',
      'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
      'Accept': 'application/vnd.github.v3+json',
    },
    body: JSON.stringify({ message: `Upload image ${filename}`, content: content, branch: 'main' })
  });
  if (res.ok) return new Response(JSON.stringify({ url: `${origin}/img/${filename}` }), { headers: { 'Content-Type': 'application/json' } });
  return new Response(JSON.stringify(await res.json()), { status: res.status });
}

async function deletePhotoImage(env, filename, sha) {
  const path = `images/${filename}`;
  const encodedPath = path.split('/').map(encodeURIComponent).join('/');
  const url = `https://api.github.com/repos/ImUpXuu/photo/contents/${encodedPath}?ref=main`;
  const res = await fetch(url, {
    method: 'DELETE',
    headers: {
      'User-Agent': 'Cloudflare-Worker-Blog-Admin',
      'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
      'Accept': 'application/vnd.github.v3+json',
    },
    body: JSON.stringify({ message: `Delete image ${filename} via Admin`, sha, branch: 'main' })
  });
  return new Response(JSON.stringify(await res.json()), { status: res.status });
}

// --- 设置管理函数 ---

async function getSettings(env) {
  const configRes = await githubRequest(env, 'src/config.ts');
  const layoutRes = await githubRequest(env, 'src/layouts/Layout.astro');
  if (!configRes.ok || !layoutRes.ok) return new Response('Fetch failed', { status: 500 });
  const configData = await configRes.json();
  const layoutData = await layoutRes.json();
  const decode = (b64) => new TextDecoder('utf-8').decode(Uint8Array.from(atob(b64.replace(/\n/g, '')), c => c.charCodeAt(0)));
  return new Response(JSON.stringify({
    config: { content: decode(configData.content), sha: configData.sha },
    layout: { content: decode(layoutData.content), sha: layoutData.sha }
  }), { headers: { 'Content-Type': 'application/json' } });
}

// 慢速扫描函数（作为最后防线保留）
async function listGitHubFiles(env, path) {
  const url = `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/${path}?ref=${env.GITHUB_BRANCH}`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Cloudflare-Worker-Blog-Admin',
      'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
      'Accept': 'application/vnd.github.v3+json',
    }
  });
  const data = await res.json();
  if (!res.ok) return new Response(JSON.stringify(data), { status: res.status });
  const files = Array.isArray(data) ? data.filter(f => f.name.endsWith('.md')).map(f => ({
    name: f.name, path: f.path, sha: f.sha, title: f.name, date: null, type: 'file'
  })) : [];
  return new Response(JSON.stringify(files), { headers: { 'Content-Type': 'application/json' } });
}