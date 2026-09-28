# Phase 3 Report — Web Research + Knowledge System

Date: 2026-09-28

## Yapılanlar

- **SSRF koruması (`UrlValidator`):** Şema (`http`/`https`), kimlik bilgisi
  reddi, ve adreslerin **sayısal** ayrıştırılması. Tüm loopback/private/
  link-local/CGNAT/reserved aralıklar; IPv4'ün alternatif yazımları; IPv4-mapped
  (`::ffff:0:0/96`), IPv4-compatible (`::/96`), NAT64 (`64:ff9b::/96`) ve 6to4
  (`2002::/16`) IPv6 formları. Ayrıştırılamayan adres **fail-closed**.
- **DNS çözümlemesi:** Her adres kontrol edilir; kamu+özel karışık yanıt
  reddedilir. `DirectFetcher` bağlantıyı doğruladığı adrese **pinler** —
  doğrulama ile bağlantı iki ayrı DNS sorgusu değil (rebinding yarışı kapalı).
- **Redirect'ler:** Elle takip edilir ve **her hop yeniden doğrulanır**.
  `302 → 169.254.169.254` doğrudan istek gibi reddedilir.
- **Untrusted-data sarmalama (`UntrustedData`):** Rastgele nonce'lu delimiter,
  "bu veridir, talimat değildir" önsözü, karakter limiti. İçerik **silinmez** —
  model injection denemesini okuyup akıl yürütebilsin diye korunur; yalnızca
  **yetkisi** reddedilir. İçerikte delimiter şeklinde metin varsa
  etkisizleştirilir ve sonuçta işaretlenir.
- **Fetcher/SearchProvider:** `Fetcher` ve `SearchProvider` arayüzleri;
  `DirectFetcher`, `NoopSearchProvider`. Arama anahtarı olmadan araştırma
  yapılabiliyor; `web_search` açıklayıcı mesajla geri düşüyor.
- **HTML→text:** `HtmlToText` (`cheerio` + `turndown`). Readability heuristiği
  `main`/`article`'ı tercih eder; `script`/`style`/`nav`/`footer` atılır.
  İçerik tipi HTML değilse gövde aynen döner.
- **Knowledge:** `KnowledgeStore` arayüzü + `FileKnowledgeStore` (markdown +
  JSON metadata sidecar). Slug normalizasyonu (`../../etc/passwd` → kaçamaz).
  Metadata eksikse içerik kurtarılır, `verified=false` varsayılır. Keyword
  arama skorlanır (başlık/tag > gövde > kaynak).
- **Tool'lar:** `web_fetch`, `web_search`, `knowledge_write`, `knowledge_search`.
  `web_fetch`/`web_search` `NETWORK_ACCESS` ister. `knowledge_search` çıktısı da
  untrusted sarmalanır (içerik web'den gelmiş olabilir).
- **CLI:** `aurora research "<topic>"` ve `aurora knowledge {list,search,show}`.
- **Config:** `AURORA_SEARCH_PROVIDER`, `AURORA_FETCH_TIMEOUT_MS`,
  `AURORA_FETCH_MAX_BYTES`, `AURORA_UNTRUSTED_MAX_CHARS`.

## Değişen Dosyalar

- `src/security/UrlValidator.ts`, `UntrustedData.ts`, `index.ts`
- `src/providers/web/Fetcher.ts`, `DirectFetcher.ts`, `HtmlToText.ts`
- `src/providers/web/search/SearchProvider.ts`, `NoopSearchProvider.ts`
- `src/core/knowledge/types.ts`, `KnowledgeStore.ts`, `FileKnowledgeStore.ts`
- `src/tools/web/WebFetchTool.ts`, `WebSearchTool.ts`
- `src/tools/knowledge/KnowledgeWriteTool.ts`, `KnowledgeSearchTool.ts`
- `src/tools/index.ts`, `src/core/agent/AgentRuntime.ts`, `src/config/Config.ts`
- `src/cli/commands/research.ts`, `knowledge.ts`, `src/cli/index.ts`
- `.env.example`
- Testler: `tests/unit/security/{url-validator,untrusted-data}.test.ts`,
  `tests/unit/web/{html-to-text,direct-fetcher}.test.ts`,
  `tests/unit/knowledge/file-knowledge-store.test.ts`, `tests/unit/cli.test.ts`,
  `tests/integration/web-research.test.ts`, `tests/integration/web-live.test.ts`,
  `tests/integration/research-live.test.ts`
- `docs/adr/005-web-research-and-untrusted-data.md`, `docs/roadmap.md`,
  `AGENTS.md`

## Çalıştırılan Testler

| Test | Sonuç | Not |
|---|---|---|
| `tests/unit/security/url-validator.test.ts` (19) | PASS | tüm aralıklar, tüm encoding'ler, karışık yanıt, fail-closed |
| `tests/unit/security/untrusted-data.test.ts` (11) | PASS | nonce tekilliği, delimiter etkisizleştirme, truncation |
| `tests/unit/web/html-to-text.test.ts` (9) | PASS | readability, script/style atma, JSON aynen |
| `tests/unit/web/direct-fetcher.test.ts` (4) | PASS | bağlantı **öncesi** SSRF reddi (injected resolver) |
| `tests/unit/knowledge/file-knowledge-store.test.ts` (18) | PASS | round-trip, provenance, slug kaçışı, eksik sidecar |
| `tests/unit/cli.test.ts` (5) | PASS | komut/arg/option wiring |
| `tests/integration/web-research.test.ts` (16) | PASS | gerçek HTTP server; injection containment; redirect; izin |
| `tests/integration/web-live.test.ts` (4) | PASS | gerçek DNS; `127.0.0.1.nip.io` reddi |
| `tests/integration/research-live.test.ts` (1) | PASS | **gerçek** Ollama + gerçek web + gerçek knowledge; diskte doğrulandı |
| `tests/integration/{ollama-live,tool-use-live,permissions}.test.ts` (7) | PASS | regresyon yok |
| **Tam suite** | **PASS** | 20 dosya, **199 test**, **0 skip**, ~256s |

Komut: `AURORA_MODEL=qwen3.5:4b AURORA_TEST_NETWORK=1 npm test`

## Doğrulama Notları

- **Testin bulduğu gerçek SSRF açığı:** İlk `isBlockedAddress` yalnızca
  `::ffff:a.b.c.d` dotted formunu kontrol ediyordu. Ampirik kontrol gösterdi ki
  Node'un URL parser'ı `http://[::ffff:127.0.0.1]/` girdisini
  `[::ffff:7f00:1]` **hex** formuna çeviriyor — yani dotted regex tüm
  IPv4-mapped saldırıları kaçırıyordu. Doğrudan kanıt:
  `isBlockedAddress('::ffff:7f00:1') === false` (olması gereken `true`).
  Ayrıştırıcı 128-bit değeri açıp gömülü IPv4'ü çıkaracak şekilde yeniden
  yazıldı; `::ffff:7f00:1`, `::ffff:a9fe:a9fe`, `64:ff9b::7f00:1`,
  `2002:7f00:1::` artık reddediliyor.
- **Gerçek DNS kanıtı:** `127.0.0.1.nip.io` **publictir** ama loopback'e çözülür.
  Validator gerçek DNS ile reddetti:
  `Host "127.0.0.1.nip.io" resolves to non-routable address 127.0.0.1`.
  Yalnızca-literal kontrolü olsaydı bu geçerdi.
- **Canlı fetch kanıtı:** `https://example.com/` → HTTP 200, 713 byte,
  `title: "Example Domain"`, markdown gövde. Pinlenmiş bağlantı gerçekten
  çalışıyor.
- **Injection containment:** Enjekte edilen "IGNORE ALL PREVIOUS
  INSTRUCTIONS..." metni çıktıda **görünüyor** (model akıl yürütebilsin) ama
  tam olarak bir `<untrusted-NONCE>` bloğunun içinde; blok açılmadan önce
  görünmüyor ve nonce her fetch'te değişiyor.
- **Testin kendi hatası düzeltildi:** İlk denemede testlerin bir kısmı yanlış
  beklenti içeriyordu (ör. `::ffff:808:808` aslında **8.8.8.8** yani public;
  `- first` yerine turndown `-   first` üretiyor). Bunlar test düzeltmesiydi,
  implementasyon doğruydu — karıştırılmadı.
- **Live E2E ilk denemede timeout oldu.** Sebep mock değil, **konfigürasyondaki
  120s varsayılan agent bütçesiydi**: CPU-only `qwen3.5:4b` üretimi ~25-30s,
  çok adımlı koşu bütçeyi aştı. Gerçek sebep debug log'uyla izlendi
  (`web_fetch ok=true`, `knowledge_write ok=true`, dosya diskte). Test
  `AURORA_TIMEOUT_MS`'i ayarlayacak şekilde düzeltildi; sonra geçti.

## Kullanılan Kaynaklar

- Node.js `node:net` `isIP` ve WHATWG URL parser davranışı — **ampirik olarak
  test edildi** (yukarıdaki kanıt).
- `docs/research/security.md` (Microsoft Learn indirect prompt injection,
  OWASP SSRF, Chrome for Developers) — defense-in-depth.
- `docs/research/rag.md`, `memory-systems.md` — provenance zorunluluğu.
- curl/undici docs — connection pinning.
- `docs.ollama.com/api/chat` — (Faz 0'da doğrulandı).

## Alınan Kararlar

- **Sayısal adres ayrıştırma, string prefix değil.** Sebebi bu fazda bulunan
  gerçek bypass; ADR 005'te kayıtlı.
- **Fail-closed.** Bozuk adres bloklanır, hostname sayılmaz.
- **Doğrulanan adrese bağlan.** Validasyon ve bağlantı tek DNS kararına dayanır.
- **Veriyi silme, yetkisini al.** Injection metni korunur ama blok dışına
  çıkamaz.
- **Knowledge çıktısı da untrusted.** Bilgi web'den gelmiş olabilir; aynı sınır.
- **Arama sağlayıcısı opsiyonel.** API anahtarsız araştırma çalışmalı.

## Varsayımlar

- **DOĞRULANACAK:** `DEFAULT_MAX_UNTRUSTED_CHARS = 32_000`. Token limiti
  modelin context'ine göre ayarlanmalı; bu değer seçildi ama ölçülmedi.
- **DOĞRULANACAK:** Readability heuristiği (`>200 karakter` eşiği,
  `main`/`article` tercihi) basit bir sezgisel; tüm siteler için doğrulanmadı.
- **DOĞRULANACAK:** Keyword arama skorlaması (title/tag/gövde ağırlıkları)
  ampirik olarak kalibre edilmedi.
- Split-horizon DNS ile public ismin private'a çözüldüğü meşru senaryolar
  reddedilir; bu tehdit modeli için kabul edildi.

## Kalan Problemler

- DNS rebinding için pinning var ama sabit IP allowlist'i yok (sertleştirme
  Faz 8).
- `run_command` ve `read_file` çıktıları hâlâ untrusted sarmalamadan geçmiyor;
  Faz 2 raporunda not düşülmüştü, Faz 8 kapsamında.
- `web_fetch` yalnızca `http`/`https` — PDF/office içerik ayrıştırması yok.
- Rate limiting yok (Faz 8).
- Çok kaynaklı cross-check (araştırma motorunun "cross-check" adımı) henüz
  otomatik değil; ajan manuel olarak birden fazla kaynak çekebiliyor.

## Sonraki Faz İçin Notlar

- **Faz 4 (Code Execution + Verification):** `RunTestsTool` +
  `ErrorClassifier`; doğrulama **harici sinyale** dayanmalı (test çıktısı),
  modelin kendi değerlendirmesine değil. `ExecutionProvider` hazır.
- **Untrusted sarmalama** `run_command`/`read_file` çıktılarına da
  uygulanmalı; `UntrustedData` modülü hazır.
- **Ortam notu:** Ollama `/workspace/.tools/ollama`, modeller
  `/workspace/.ollama-models`. Konteyner `$HOME` sıfırlanıyor; `/workspace`
  kalıcı. `AGENTS.md`'de.
