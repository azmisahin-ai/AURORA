# Phase 10 Report — UI (Ayrı Katman)

Date: 2026-09-29

## Yapılanlar

Phase 10, ADR 012'de kaydedilen kararlarla inşa edildi: **framework'süz vanilla
ES modülleri**, API'nin doğrudan servis ettiği statik dosyalar, **hiç `innerHTML`
yok**. UI çekirdeğe yalnızca HTTP üzerinden bağlanır — `src/`'den hiçbir şey
import etmez, yani `core`'a ikinci bir giriş noktası olamaz.

- **`src/api/server.ts`:** `/` ve `/ui/*` statik rotası. Yol, dosya sistemi
  araçlarının kullandığı **aynı `PathValidator`**'dan geçer; `resolve` değil
  **`resolveReal`** kullanılır — sözlüksel olarak `ui/` içinde görünen bir dosya
  yine de dışarıya symlink olabilir ve bu rota **token'sız erişilebilir**. CSP
  (`default-src 'none'; script-src 'self'; connect-src 'self'; ...`),
  `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`. Uzantı
  allowlist'i (`html/js/css/svg/json/txt/...`) bilinmeyeni `text/plain` yapar.
- **`src/api/server.ts` — yeni veri rotası:** `GET /knowledge/:kind/:slug`.
  Liste rotası yalnızca metadata döndürür (bu bir görüntüleme yoludur, her
  satıra tam gövde koymak yanlış olurdu); detay görünümü gövdeyi buradan çeker.
  Yanıt, liste ile **aynı düz şekil** artı `content`/`path`'tir.
- **`src/api/RunRegistry.ts`:** `list()` — en yeni önce. Ajan paneli tek tek
  id değil, kümenin tamamına ihtiyaç duyar.
- **`src/config/Config.ts` / `src/cli/commands/serve.ts`:** `AURORA_UI_DIR`.
  `serve`, dizin yoksa statik rotayı **hiç bağlamaz** (`stat` kontrolü).
- **`ui/`:** `index.html`, `styles.css`, `app.js`, `lib/{dom,format,api,panels}.js`.
  Üç panel: Tasks (durum filtresi, detay), Agents (çalışan/bitmiş koşular,
  trajectory), Knowledge (tür filtresi, arama, detay). Token `sessionStorage`'da,
  **header ile** gönderilir, URL'de asla.

## Değişen Dosyalar

- `src/api/server.ts` — statik UI rotası, `GET /knowledge/:kind/:slug`, CSP/güvenlik başlıkları
- `src/api/RunRegistry.ts` — `list()`
- `src/config/Config.ts` — `uiDir` (`AURORA_UI_DIR`)
- `src/cli/commands/serve.ts` — UI dizinini varlık kontrolüyle bağlama
- `ui/` — yeni dizin (7 dosya)
- `docs/adr/012-ui-layer.md` — yeni
- `package.json` — `jsdom` **yalnızca devDependency** (aşağıda)
- `tests/integration/ui.test.ts`, `tests/unit/ui/{format,panels,ui-xss-guard}.test.ts` — yeni

## Çalıştırılan Testler

| Test | Sonuç | Not |
|---|---|---|
| `npx tsc -p tsconfig.json --noEmit` | PASS | `ui/` tsconfig dışında (vanilla JS) |
| `npx vitest run` (tüm suite) | PASS | **545 passed, 5 skipped (550)** |
| `tests/integration/ui.test.ts` | PASS | 13 test — gerçek `node:http` sunucusu, scripted runtime (Ollama gerekmez) |
| `tests/unit/ui/panels.test.ts` | PASS | 12 test — jsdom altında DOM kurucuları |
| `tests/unit/ui/format.test.ts` | PASS | 6 test — saf modül, DOM yok |
| `tests/unit/ui/ui-xss-guard.test.ts` | PASS | 3 test — kaynak taraması |
| Tarayıcı duman testi (gerçek Chromium) | PASS | Aşağıda |
| 5 mutasyon testi | Hepsi yakalandı | Aşağıda |
| 6. mutasyon: `--no-ui` eşlemesi bozuldu | Yakalandı | Aşağıda (M6) |

### Mutasyon testi (testler gerçekten koruyor mu?)

Testin yeşil olması, testin *bir şeyi* doğruladığını kanıtlamaz. Her güvenlik
kontrolünü kasten kırıp ilgili testin **FAIL** verdiğini doğruladım:

| # | Mutasyon | Beklenen | Sonuç |
|---|---|---|---|
| M1 | `resolveReal` → `resolve` (symlink kontrolü kaldırıldı) | symlink testi FAIL | FAIL ✓ |
| M2 | CSP `default-src * 'unsafe-inline'` yapıldı | CSP testi FAIL | FAIL ✓ |
| M3b | Token kontrolü `if (false)` yapıldı | auth testi FAIL | FAIL ✓ |
| M4 | `isSafeHref` şema allowlist'i kaldırıldı | 3 test FAIL | FAIL ✓ |
| M5 | `textContent` → `innerHTML` | 5 test FAIL (kaynak-koruma dahil) | FAIL ✓ |
| M6 | `serveEnvOverrides` `--no-ui` eşlemesi `noUi`'ye çevrildi | CLI testi FAIL | FAIL ✓ |

### Bulunan gerçek hata: `--no-ui` sessizce hiçbir şey yapmıyordu

Commander, `--no-ui` seçeneğini `options.ui = false` olarak saklar (baştaki
`no` düşer). Kod `options.noUi` okuyordu — bu **derlenir**, çünkü arayüz öyle
tanımlanmıştı, ve **daima `undefined`**'dır. Yani bayrak hiçbir zaman statik
rotayı kapatmıyordu; README'de belgelenen davranış yanlıştı.

Bu tür bir hata typecheck'ten kaçar ve "bayrak kayıtlı mı" testinden de kaçar.
Düzeltme, eşlemeyi saf bir `serveEnvOverrides(options)` fonksiyonuna çıkarmak ve
**eşlemeyi çalıştıran** bir test yazmaktı. Uçtan uca doğrulandı: `serve --no-ui`
`GET /` → `404 not_found`; varsayılan `serve` → `200 text/html` + `nosniff`.
M6, düzeltmeyi kasten geri alıp testin kırmızıya döndüğünü kanıtlar.

### Tarayıcı duman testi (iddia değil, gözlem)

Gerçek Chromium ile `aurora serve` açıldı, `xss-probe` adlı bilerek zararlı bir
knowledge girdisi yazıldı:

```
title:   <img src=x onerror="globalThis.__pwned=true">PWNED
content: Body: <script>globalThis.__pwned=true</script> and <img src=x onerror=...>
source:  javascript:globalThis.__pwned=true
```

Gözlem: başlık ve içerik **literal metin** olarak render edildi; kaynak bir
bağlantı değil düz metin; sayfa başlığı değişmedi; `__pwned` atanmadı. Yani
payload gerçek tarayıcıda **inert**.

## Kullanılan Kaynaklar

- ADR 012 §3 — CSP ve `textContent` gerekçesi (Chrome for Developers / MDN)
- `src/security/PathValidator.ts` — `resolveReal` sözleşmesi (ADR 004)
- Bu fazda yeni dış kaynak kullanılmadı; tarayıcı gözlemi birincil kanıttır.

## Alınan Kararlar

- **`jsdom` eklendi ve bu, ADR 012'de düzeltildi.** İlk taslak "DOM gerekmez"
  diyordu; DOM kurucularını test etmek için bu **yanlıştı**. `jsdom` bir
  **devDependency**'dir: gönderilmez, UI'yi çalıştırmak için gerekmez. Saf
  formatlama modülü yine jsdom'suz test edilir. İddia düzeltildi, gizlenmedi.
- **Symlink kontrolü statik rotada zorunlu.** Rota token'sız erişilebilir;
  `resolve` yeterli değildir.
- **Detay rotası eklendi** çünkü liste rotası gövde döndürmez ve panel boş
  kalıyordu — bu, tarayıcı testiyle bulunan gerçek bir eksikti.

## Varsayımlar

- UI tek bir operatör içindir; çok kullanıcılı senaryo kapsam dışı.
- Statik dosyalar `uiDir` altında güvenilirdir; asıl tehdit **veridir** (API
  yanıtları), o da yapısal olarak metne zorlanmıştır.

## Kalan Problemler

- UI'de gerçek zamanlı akış yok; 4 sn'lik polling var. ADR 012'de framework'e
  geçiş tetikleyicisi açıkça yazıldı.
- `panels.js` kapsamı iyi ama `app.js` (olay bağlama, polling döngüsü) yalnızca
  tarayıcı duman testiyle kapsanıyor, otomatik testi yok.

## Sonraki Faz İçin Notlar

Roadmap'te Phase 10 son fazdır. Bundan sonrası, kullanıcı geri bildirimine göre
önceliklendirilecek bakım işleridir (ör. UI için E2E, streaming).
