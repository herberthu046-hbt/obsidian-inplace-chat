'use strict';

async function openVaultFile(app, filePath) {
  const file = app.vault.getAbstractFileByPath(filePath);
  if (!file || typeof file.extension !== 'string') throw Error('文件不存在或已移动，请刷新列表后重试。');
  const workspace = app.workspace;
  let leaf;
  workspace.iterateAllLeaves(candidate => {
    if (!leaf && candidate.view.file?.path === file.path) leaf = candidate;
  });
  if (!leaf) {
    leaf = workspace.getLeaf('tab');
    await leaf.openFile(file, { active: true });
  }
  await workspace.revealLeaf(leaf);
  workspace.setActiveLeaf(leaf, { focus: true });
  return leaf;
}

module.exports = { openVaultFile };
