RXGUARD UNIFIED v1.2 — AI GELİŞTİRİCİ TAM YETKİ
==================================================

AMAÇ
Artık geliştirmeyi kendi RxGuard sitendeki "AI Geliştirici" üzerinden yapabilirsin.

AI GELİŞTİRİCİNİN DEĞİŞTİREBİLDİĞİ ALANLAR
- Web/site tasarımı ve butonlar
- Sayfalar ve kullanıcı modları
- app.js backend/API
- data/* içindeki SUT kuralları, kişisel kurallar, ilaç/eşdeğer verileri
- Android kaynak kodu
- GitHub Actions workflow'ları

ÇALIŞMA ŞEKLİ
Komut yaz -> HAZIRLA -> değişecek dosyaları gör -> ONAYLA VE UYGULA.
Uygulandığında tek GitHub commit oluşturur.
Aynı commit:
1) Render web/sunucuyu deploy eder.
2) GitHub Actions Android APK'yı üretir.

RENDER ENVIRONMENT'A BİR KEZ EKLENECEKLER
GITHUB_REPO = ednenn/RxGuard-Standalone
GITHUB_BRANCH = main
GITHUB_TOKEN = GitHub fine-grained personal access token

GITHUB_TOKEN YETKİLERİ
Repository access: yalnız RxGuard-Standalone
Contents: Read and write
Actions: Read and write (workflow dosyalarının değişebilmesi için)

MEVCUT AI DEĞİŞKENLERİ DE KALACAK
AI_BASE_URL
AI_MODEL
AI_API_KEY
ADMIN_PASSWORD
SESSION_SECRET

GÜVENLİK
- .env ve secret dosyaları AI tarafından değiştirilemez.
- Değişiklik önce staging alanında JS sözdizimi kontrolünden geçer.
- Uygulamadan önce otomatik yedek alınır.
- GERİ AL butonu korunur.
- Onaysız değişiklik canlıya uygulanmaz.

YÜKLEME
Bu ZIP'in içindeki TÜM dosyaları RxGuard-Standalone deposuna tek seferde yükle ve Commit changes de.
