import * as llm from './llm.js';
import { mountSettings } from './settings-ui.js';

const ui = mountSettings(document.getElementById('settingsRoot'), {
  onCancel: async () => ui.load(await llm.loadSettings()), // batalkan perubahan yang belum disimpan
});
ui.load(await llm.loadSettings());
