// ─── 虚拟文件树的纯函数（供 UI 渲染目录层级，便于单测）─────────────────
// 沙箱是「路径即结构」的扁平字典（uploads/a.png、outputs/x/y.md），
// 这里按 '/' 还原成目录树，并汇总每级的文件数与体积。

const cleanParts = (p) => String(p || '').split('/').map((s) => s.trim()).filter((s) => s && s !== '.');

/**
 * @param {Array<{path:string,size?:number}>} files fs.list() 的输出
 * @returns {Array<Node>} 根层节点；Node = {type:'dir'|'file', name, path, size, children?, count?, dirs?}
 */
export function buildFileTree(files) {
  const root = { type: 'dir', name: '', path: '', children: [], byName: new Map() };
  for (const f of (Array.isArray(files) ? files : [])) {
    const parts = cleanParts(f && f.path);
    if (!parts.length) continue;
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const name = parts[i];
      const path = node.path ? `${node.path}/${name}` : name;
      let dir = node.byName.get(path);
      if (!dir) {
        dir = { type: 'dir', name, path, children: [], byName: new Map() };
        node.children.push(dir);
        node.byName.set(path, dir);
      }
      node = dir;
    }
    node.children.push({ type: 'file', name: parts[parts.length - 1], path: parts.join('/'), size: Number(f.size) || 0 });
  }
  finalize(root);
  return root.children;
}

// 目录在前、文件在后，同级按名称自然排序（image-2 排在 image-10 前）
const collator = new Intl.Collator('zh', { numeric: true, sensitivity: 'base' });
function finalize(node) {
  if (node.type === 'dir') {
    for (const c of node.children) finalize(c);
    node.children.sort((a, b) => (a.type === b.type ? collator.compare(a.name, b.name) : a.type === 'dir' ? -1 : 1));
    let size = 0; let count = 0; let dirs = 0;
    for (const c of node.children) {
      size += c.size || 0;
      if (c.type === 'dir') { dirs++; count += c.count; } else { count += 1; }
    }
    node.size = size;
    node.count = count;       // 含嵌套的文件总数
    node.dirs = dirs;          // 直接子目录数
  }
  delete node.byName;
}

/** 收集节点下的所有文件路径（目录节点用于打包，文件节点返回自身） */
export function collectPaths(node) {
  if (!node) return [];
  if (node.type === 'file') return [node.path];
  const out = [];
  for (const c of node.children) out.push(...collectPaths(c));
  return out;
}

/** 目录树整体统计：文件数 / 目录数（含嵌套）/ 总字节，供工具栏摘要 */
export function treeStats(nodes) {
  const list = Array.isArray(nodes) ? nodes : [];
  let files = 0; let size = 0; let dirs = 0;
  for (const n of list) {
    // 目录节点的 count/size 已汇总全部子孙，根层累加即为总量
    files += n.type === 'dir' ? (n.count || 0) : 1;
    size += n.size || 0;
  }
  const walkDirs = (l) => {
    for (const n of l) if (n.type === 'dir') { dirs += 1; walkDirs(n.children); }
  };
  walkDirs(list);
  return { files, dirs, size };
}

/** 把树摊平成可见行（折叠的目录不展开子项），UI 直接按序渲染 */
export function flattenTree(nodes, { isCollapsed, depth = 0, out = [] }) {
  for (const node of nodes) {
    out.push({ ...node, depth, hasChildren: node.type === 'dir' && node.children.length > 0 });
    if (node.type === 'dir' && !(isCollapsed && isCollapsed(node.path))) flattenTree(node.children, { isCollapsed, depth: depth + 1, out });
  }
  return out;
}
