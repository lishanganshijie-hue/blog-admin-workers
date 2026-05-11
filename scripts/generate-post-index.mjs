import fs from 'fs';
import path from 'path';

const POSTS_DIR = './src/content/posts';
const OUTPUT = './src/content/posts/posts-index.json';

function walk(dir) {

  let results = [];

  const list = fs.readdirSync(dir);

  list.forEach(file => {

    const filePath = path.join(dir, file);

    const stat = fs.statSync(filePath);

    if (stat && stat.isDirectory()) {

      results = results.concat(walk(filePath));

    } else if (file.endsWith('.md')) {

      if (file === 'posts-index.json') return;

      const content = fs.readFileSync(filePath, 'utf-8');

      const titleMatch = content.match(/title:\s*(.+)/);

      const dateMatch = content.match(/published:\s*(.+)/);

      const title = titleMatch
        ? titleMatch[1].replace(/['"]/g, '').trim()
        : file.replace('.md', '');

      const date = dateMatch
        ? dateMatch[1].trim()
        : '';

      const relative = filePath
        .replace(POSTS_DIR, '')
        .replace(/\\/g, '/');

      const parts = relative.split('/').filter(Boolean);

      let category = '';

      let slug = file.replace('.md', '');

      if (parts.length >= 2) {

        category = parts[0];

        slug = parts[1].replace('.md', '');
      }

      results.push({
        title,
        slug,
        category,
        date
      });
    }
  });

  return results;
}

const posts = walk(POSTS_DIR);

posts.sort((a, b) => {

  if (!a.date) return 1;

  if (!b.date) return -1;

  return new Date(b.date) - new Date(a.date);
});

fs.writeFileSync(
  OUTPUT,
  JSON.stringify(posts, null, 2),
  'utf-8'
);

console.log(`Generated ${posts.length} posts`);
