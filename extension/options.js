const origin = document.getElementById('origin');
const token = document.getElementById('token');
const save = document.getElementById('save');

chrome.storage.sync.get(['origin', 'token']).then((cfg) => {
  origin.value = cfg.origin || '';
  token.value = cfg.token || '';
});

save.addEventListener('click', async () => {
  await chrome.storage.sync.set({ origin: origin.value.trim(), token: token.value.trim() });
  save.textContent = 'Saved';
});
