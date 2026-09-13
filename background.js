chrome.sidePanel.setPanelBehavior({openPanelOnActionClick:true}).catch(console.error);
// Manual archives never read or modify folders in the background.
chrome.alarms.clear('quiet-notes-inbox').catch(console.error);
