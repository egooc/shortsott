const fs = require('fs');
const path = require('path');

function loadPrompt(fileName) {
  const promptPath = path.join(__dirname, '../prompts', fileName);
  return fs.readFileSync(promptPath, 'utf8');
}

module.exports = { loadPrompt };
