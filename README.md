# Acil Servis Nöbet Sistemi

Tarayıcıdan kullanılan aylık nöbet planlama uygulaması. Tek veri kaynağı, üç görünüm:

- **Çizelge**: nöbet ve mazeret girişi (tıkla, sürükleyerek boya, klavye: 2 / 1 / 8 / Del, Ctrl+Z)
- **Nöbet İsimleri**: günlük isim listesi
- **Puantaj**: resmi aylık bildirim çizelgesi (önce uzmanlar, sonra tabipler, alfabetik)

Excel çıktıları `templates/` klasöründeki şablonların üzerine yazılır: `puantaj.xlsx`,
`nobetisimler_template.xlsx`, `nobetprogramirenkli.xlsx`.

## Yapı

| Dosya | Görev |
|---|---|
| `app.py` | Flask sunucusu: giriş, veri kaydetme, yayınlama, Excel indirme |
| `model.py` | Veri yapısı ve kurallar (sıralama, Türkçe büyük harf, eski verinin taşınması) |
| `exports.py` | Üç Excel çıktısı |
| `public/` | Tarayıcı arayüzü (harici kütüphane yok). Yalnızca bu klasör dışarıya açıktır |

Hekimler sabit bir kimlikle tutulur; ad değişikliği nöbetleri etkilemez. Kaydı olan hekim silinirse pasif yapılır.
Hastane adı, imza alanları, mazeret kodları ve renkler arayüzdeki **Ayarlar** penceresinden değiştirilir.

## Ortam değişkenleri (Render → Environment)

| Değişken | Açıklama |
|---|---|
| `MONGODB_URI` | MongoDB Atlas bağlantısı (yoksa yerel SQLite: yalnızca geliştirme için) |
| `ADMIN_PASSWORD` | `admin` hesabının şifresi |
| `USER_PASSWORD` | `pratisyen` hesabının şifresi |
| `SECRET_KEY` | Oturum anahtarı (uzun rastgele metin) |

## Yerelde çalıştırma

```bash
pip install -r requirements.txt
ADMIN_PASSWORD=... USER_PASSWORD=... INSECURE_COOKIES=1 python app.py
```
