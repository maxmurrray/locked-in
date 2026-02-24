const SERVER = 'https://locked-in.vercel.app'; // will update

// Check tab URLs against tracked sites
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete' || !tab.url) return;
  
  chrome.storage.local.get(['lockedin_user', 'lockedin_tracked'], (data) => {
    if (!data.lockedin_user || !data.lockedin_tracked) return;
    
    const url = new URL(tab.url);
    const domain = url.hostname.replace('www.', '');
    
    if (data.lockedin_tracked.includes(domain)) {
      // BUSTED
      fetch(SERVER + '/api/violation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: data.lockedin_user.id,
          domain: domain
        })
      }).then(r => r.json()).then(d => {
        if (d.busted) {
          chrome.notifications.create({
            type: 'basic',
            iconUrl: 'icon.png',
            title: '💀 BUSTED',
            message: `You opened ${domain}. Your friends have been notified.`
          });
        }
      }).catch(() => {});
    }
  });
});
