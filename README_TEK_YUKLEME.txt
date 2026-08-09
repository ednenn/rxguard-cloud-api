RXGUARD UNIFIED v1.1 — TEK REPO / TEK YÜKLEME

BU PAKET ARTIK WEB VE ANDROID'I AYRI AYRI YÜKLETMEZ.

TEK GITHUB DEPOSU:
RxGuard-Standalone

YÜKLEME:
1) ZIP'i aç.
2) İçindeki TÜM dosya ve klasörleri RxGuard-Standalone deposunun KÖKÜNE yükle.
3) Commit changes.

SONUÇ:
- Render, aynı commit ile web/sunucu tarafını otomatik deploy eder.
- GitHub Actions, aynı commit ile android/ klasöründen APK üretir.
- Yani tek yükleme ve tek commit iki tarafı birden günceller.

DOSYA YAPISI:
app.js
public/
android/
.github/workflows/android.yml

NOT:
Mevcut RxGuard-Android deposunu artık günlük güncellemede kullanmana gerek yok.
APK, RxGuard-Standalone > Actions bölümünden üretilecek.
