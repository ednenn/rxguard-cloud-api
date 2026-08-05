# RxGuard Cloud API

1. GitHub'da `rxguard-cloud-api` adlı boş depo oluştur.
2. Bu ZIP içindeki dosyaları deponun ana dizinine yükle.
3. Cloudflare Workers & Pages ekranından GitHub deposunu bağla.
4. KV namespace oluştur: `RXGUARD_DATA`.
5. Namespace ID değerini `wrangler.jsonc` içindeki `KV_NAMESPACE_ID_BURAYA` yerine yaz.
6. Deploy sonrası `/health` adresini kontrol et.

Beklenen cevap:
`{"ok":true,"service":"RxGuard Cloud API","storageReady":true}`

Şifre, token veya özel anahtarları GitHub'a yükleme.
