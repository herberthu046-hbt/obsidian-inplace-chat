'use strict';
const fs = require('node:fs');
const path = require('node:path');

// An installer may stage an explicit settings change while Obsidian is open.
// Apply it after loading data.json, so the old plugin cannot undo it on unload.
async function applyPendingSettings(plugin, pluginDir) {
  const file = path.join(pluginDir, '.installation', 'settings-on-reload.json');
  if (!fs.existsSync(file)) return false;
  const raw = fs.readFileSync(file, 'utf8'), update = JSON.parse(raw);
  if (update.version !== 1 || typeof update.model !== 'string' || !update.model.trim() ||
      !['minimal', 'low', 'medium', 'high', 'xhigh'].includes(update.effort)) throw new Error('Invalid pending model settings.');
  plugin.settings = { ...plugin.settings, model: update.model, effort: update.effort };
  await plugin.saveLocal();
  // Retain a newer update if another installer staged one during the save.
  if (fs.readFileSync(file, 'utf8') === raw) fs.unlinkSync(file);
  return true;
}
module.exports = { applyPendingSettings };
