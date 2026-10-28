// Tasks Filter Pro – background service worker: loads the bundled brands.json when the extension is installed.
importScripts('brands.js');

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === 'install') seedBundled().catch(() => {});
});
