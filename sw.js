// 서비스 워커가 푸시 이벤트를 받았을 때 실행
self.addEventListener('push', function(event) {
  if (!event.data) return;

  const data = event.data.json();
  const title = data.title;
  const options = {
      body: data.body,
      icon: '/icon.png', // 알림 아이콘 (프로젝트 폴더에 icon.png 파일 필요)
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

// 알림 클릭 시 앱 열기
self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  event.waitUntil(
      clients.openWindow('/')
  );
});