self.addEventListener('install',()=>self.skipWaiting());
self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));
self.addEventListener('notificationclick',event=>{event.notification.close();try{const url=new URL(event.notification.data?.url);if(url.protocol==='https:'&&['coursera.org','www.coursera.org'].includes(url.hostname)&&/^\/(learn|specializations|professional-certificates)\//.test(url.pathname))event.waitUntil(self.clients.openWindow(url.href));}catch{}});
