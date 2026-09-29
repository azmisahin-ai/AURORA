# Phase 9 Report — CLI + API

Date: 2026-09-28

## Yapılanlar

Phase 9'un iki yarısından **API** yarısı bu fazda inşa edildi; CLI'ın
`run | research | knowledge | tasks | sessions` komutları önceki fazlarda
tamamlanmıştı ve yeniden yazılmadı. Eklenen tek komut `aurora serve`.

Framework seçimi Phase 0'ın ertelediği şekilde **uygulama anında araştırılarak**
yapıldı ve ADR 011'e kaydedildi: Express 5 / Fastify 5 / Hono 5 / `node:http`
karşılaştırıldı; **`node:http`** seçildi (sıfır yeni bağımlılık, beş rota bir web
framework'ünün bağımlılık yüzeyini haklı çıkarmıyor; gerekçe ve kaynaklar ADR
011 §1'de).

- **`src/api/types.ts`:** `RuntimePort` (`runTask`, `health`), `ApiServerOptions`,
  `ApiRunRecord`, `ApiRunStatus`, `ApiDeps`. `RuntimePort` **dar bir port**:
  sunucu `LLMProvider`'ı değil, çalıştırılabilir bir runtime'ı tanır.
  `AgentRuntime` bu arayüzü yapısal olarak karşılar — bu yüzden API testleri
  **Ollama gerektirmez**.
- **`src/api/RunRegistry.ts`:** Eşzamanlılık sınırı (`maxConcurrentRuns`; aşan
  istek **kuyruğa alınmaz, 429 alır**), `AbortController` ile iptal, bitmiş
  kayıtların budanması (`maxRetained`; uzun ömürlü sunucu bellek sızıntısı
  olmasın), `apiStatus` eşlemesi (`aborted → cancelled`, `error`/`max_iterations`
  → `failed`) ve **scrub** (aşağıda).
- **`src/api/server.ts`:** `node:http` üzerinde ~60 satırlık router. Bearer auth,
  istek gövdesi **akış sırasında** sınırlanır, istemci başına token-bucket hız
  sınırı, `assertSafeBinding` ile başlangıçta güvenli-bind kontrolü,
  `apiConfirmationGate` ile mutasyon politikası.
- **Rotalar:** `GET /health` (tek kimlik-doğrulamasız rota), `POST /agent/run`
  (202 + `runId`; `?wait=1` ile senkron, `AURORA_API_MAX_SYNC_MS` ile sınırlı),
  `POST /agent/cancel`, `GET /runs/:id`, `GET /tasks/:id`,
  `GET /knowledge/search?q=`.
- **`src/cli/commands/serve.ts`:** `aurora serve [--host --port --model
  --allow-mutation]`; config'ten runtime + store'ları kurar, kapıyı
  `AURORA_API_ALLOW_MUTATION`'a göre seçer, SIGINT/SIGTERM ile kapanır.
- **`src/config/Config.ts`:** `apiHost`, `apiPort`, `apiToken`,
  `apiAllowMutation`, `apiMaxBodyBytes`, `apiRateLimit`, `apiRateRefill`,
  `apiMaxConcurrentRuns`, `apiMaxSyncMs` (zod, varsayılanlar güvenli tarafta).
- **`src/index.ts`, `src/api/index.ts`:** API yüzeyi dışa açıldı.

## Tasarım kararları (özet; ayrıntı ADR 011)

- **Portlar, provider'lar değil.** `createApiServer` `RuntimePort` alır; testler
  senaryolu bir sahte runtime geçirir. Bu, gerçek HTTP sunucusunu test edip
  modele hiç dokunmamayı mümkün kılar.
- **Varsayılan asenkron.** `POST /agent/run` bir `runId` döndürür; istemci
  `GET /runs/:id` ile yoklar. `?wait=1` satır içi çalışır ama sınır aşılırsa
  **asılı kalmaz, 202 döner**.
- **Mutasyonda fail-closed.** HTTP isteğinin terminali yoktur; bu yüzden HTTP
  koşusu varsayılan olarak `DenyAllGate` alır ve `write_file`/`edit_file`/
  `run_command` reddedilir. Opt-in: `AURORA_API_ALLOW_MUTATION=true`. Bu, Phase
  8'in `ConfirmationGate` portunun **yeniden kullanımıdır**, ikinci bir politika
  değil.
- **Koşular kalıcı değil (bilinçli).** Yarım çalışmış bir komut yeniden
  başlatılamaz; kalıcı iş Phase 6 `tasks`'ın işidir. Bu, dokümanda açıkça
  yazılı, ima edilmiş değil.

## Değişen / eklenen dosyalar

- `src/api/types.ts` — yeni
- `src/api/RunRegistry.ts` — yeni
- `src/api/server.ts` — yeni
- `src/api/index.ts` — yeni
- `src/cli/commands/serve.ts` — yeni
- `src/cli/index.ts` — `serve` kaydı
- `src/config/Config.ts` — API alanları
- `src/index.ts` — API export'ları
- `tests/unit/api/api-security.test.ts` — yeni
- `tests/unit/api/run-registry.test.ts` — yeni
- `tests/integration/api.test.ts` — yeni
- `tests/unit/config.test.ts`, `tests/unit/cli.test.ts` — Phase 9 kapsamı
- `docs/adr/011-http-api.md`, `docs/roadmap.md`, `docs/architecture.md`,
  `docs/reports/phase-9.md`, `AGENTS.md`, `README.md`, `.env.example`

## Çalıştırılan Testler

| Test | Sonuç | Not |
|---|---|---|
| `npx tsc --noEmit` | PASS | tip denetimi temiz |
| `vitest run tests/unit/api tests/integration/api.test.ts` | PASS | 30 test (3 dosya) |
| `vitest run --exclude 'tests/**/*-live.test.ts'` | PASS | 500 test / 44 dosya, 0 FAIL |
| `vitest run` (canlı dahil) | PASS | 512 passed, 5 skipped (517), 46 passed + 5 skipped dosya |
| Mutasyon M1 — public bind izni | PASS (yakalandı) | 2 failed / 28 passed |
| Mutasyon M2 — token kontrolü kaldırıldı | PASS (yakalandı) | 1 failed / 29 passed |
| Mutasyon M3 — mutasyon kapısı hep allow | PASS (yakalandı) | 1 failed / 29 passed |
| Mutasyon M4 — gövde sınırı kapatıldı | PASS (yakalandı) | 1 failed / 29 passed |
| Mutasyon M5 — hız sınırı yok sayıldı | PASS (yakalandı) | 1 failed / 29 passed |
| Elle smoke: `aurora serve` + curl | PASS | `/health`, `/knowledge/search`, `/agent/run` gerçek sunucuda |

Canlı integration testlerinin 5'i **skip**: bu makinede Ollama şu an
çalışmadığı için (API testleri Ollama gerektirmez; ayrı bir canlı-Ollama
grubudur). Skip, PASS olarak raporlanmadı.

Elle doğrulama sırasında `aurora serve` şu satırı yazdı:
`aurora api listening on http://127.0.0.1:8791 (no auth (loopback only);
mutation denied)`. `/health` → `503` (Ollama kapalı, dürüst yanıt),
`/knowledge/search?q=ollama` → `{"results":[]}`, `/agent/run` → `202` + `runId`
ve koşu durumu `failed` + `"Failed to reach Ollama …"` — sahte bir başarı yok.

## Kullanılan Kaynaklar

- ADR 011 içinde çerçeve karşılaştırması (Express/Fastify/Hono/`node:http`) ve
  Node `http` API'si — erişim tarihi 2026-09-28.

## Alınan Kararlar

- `node:http` (ADR 011 §1): yeni bağımlılık yok; rota sayısı az.
- API `cli`'ın **eşi**, `core`'un üstünde; `core` `api`'yi import etmez.
- Varsayılan bind loopback; token'sız public bind **başlangıçta reddedilir**.
- Bearer karşılaştırması sabit zamanlı (`sha256` + `timingSafeEqual`), uzunluk
  sızdırmaz.
- HTTP koşusu varsayılan olarak mutasyonu reddeder (fail-closed).
- Koşular bellekte tutulur, kalıcı değildir (bilinçli).

## Varsayımlar

- Tek paylaşılan token yeterli; çok-kiracılı kapsam (per-token scope) bu fazda
  tasarlanmadı (DOĞRULANACAK olarak işaretli).
- TLS proses içinde sonlandırılmaz; public dağıtım bir reverse proxy arkasında
  beklenir (DOĞRULANACAK).

## Kalan Problemler

- **DOĞRULANACAK:** çok-kiracılı authz / per-token yetki kapsamı tasarlanmadı.
- **DOĞRULANACAK:** proses içi TLS yok; reverse proxy varsayımı.
- **DOĞRULANACAK:** hız sınırı proses içidir, yeniden başlatmada sıfırlanır
  (Phase 8 notuyla aynı).
- `GET /runs/:id` uzun süre yoklanırsa bitmiş kayıtlar `maxRetained` nedeniyle
  budanabilir; istemci 404'ü "bilinmeyen" olarak ele almalı (dokümante edildi).

## Sonraki Faz İçin Notlar

- **Phase 10 (UI)** ayrı bir katman olarak `src/api` üzerine kurulmalı; çekirdeğe
  yeni bir giriş noktası eklememeli. Task paneli `/tasks/:id` + `/runs/:id`,
  knowledge browser `/knowledge/search`, trajectory `run.result.trajectory`
  alanından beslenebilir.
- UI'ya geçmeden önce API'nin SSE/streaming bir uç (`/runs/:id/events`)
  gerektirip gerektirmediği değerlendirilmeli; şu an yoklama (polling) var.
- Kalıcı koşu geçmişi gerekirse Phase 6 `TaskStore` ile birleştirilmeli; ayrı bir
  kayıt biçimi icat edilmemeli.
