const CACHE='winflex-fichaje-v1';
self.addEventListener('install',function(e){self.skipWaiting();});
self.addEventListener('activate',function(e){e.waitUntil(self.clients.claim());});
self.addEventListener('fetch',function(e){
  if(e.request.method!=='GET'){return;}
  e.respondWith(fetch(e.request).then(function(r){
    try{if(r&&r.status===200&&e.request.url.indexOf(self.location.origin)===0){var c=r.clone();caches.open(CACHE).then(function(ca){ca.put(e.request,c);});}}catch(err){}
    return r;
  }).catch(function(){return caches.match(e.request);}));
});
