# Phase 4 Report — Code Execution + Verification Loop

Date: 2026-09-28

## Yapılanlar

- **Hata sınıflandırma (`ErrorClassifier`):** `ExecutionFailure` (exit code,
  stdout/stderr, timeout) veya atılmış bir hata, kategoriye ve eyleme
  eşlenir: `TRANSIENT→retry`, `CONFIGURATION/AUTHENTICATION→report_to_user`,
  `NETWORK→backoff_retry`, `CODE→inspect_and_fix`, `VALIDATION→fix_input`,
  `PERMISSION→request_permission`, `UNKNOWN→stop`. Yapısal sinyal metinden
  üstündür (`status: 401`, mesajda "invalid" geçse bile). `AbortError`
  transient ama **retryable değil**.
- **Harici doğrulama portu (`Verifier`):** `AgentLoop`'a opsiyonel enjekte
  edilir. Karar **process exit code**'undan gelir; modelin kendi görüşünden
  değil (ADR 001/006).
- **`CommandVerifier`:** Yapılandırılmış komutu çalıştırır. `CommandValidator`
  ve `COMMAND_EXECUTION` izni aynı kapıdan geçer. İzin yoksa veya komut
  politikaya takılırsa **skipped** döner — pass değil.
- **Tamamlama kapısı (`gateCompletion`):** Doğrulama **yalnızca** workspace'i
  değiştiren başarılı bir tool çağrısından sonra çalışır. Geçerse `completed`;
  kalırsa sınıflandırılmış hata modele geri beslenir ve döngü onarım için
  devam eder; bütçe biterse `max_verifications` ile escalate edilir.
- **`mutatesWorkspace`:** Tool başına bildirilir, `ToolRegistry` tarafından
  **yalnızca başarıda** set edilir. `write_file` evet; `knowledge_write` hayır
  (kod değil); `run_command` hayır (doğrulayıcının çalıştırdığı aracın kendisi
  — kendini tetiklerdi).
- **`run_tests` tool'u:** `AURORA_TEST_COMMAND` varsa kaydedilir. Model kendi
  işini denetleyebilsin diye; verdict exit code'dan.
- **Vakum tuzağı (`TestSummary`):** Node v24.21.0'da `node --test`, hiç test
  dosyası bulamazsa **exit 0** verir (`ℹ pass 0 / ℹ fail 0`). Sadece exit
  code'a bakan bir doğrulayıcı boş koşuyu "geçti" sanardı. `ranNoTests` bunu
  yakalar ve **fail** sayar. Parser `tools` ile `providers` arasında
  paylaşılır; ikisi aynı çıktıyı aynı şekilde okur.
- **Config:** `AURORA_TEST_COMMAND`, `AURORA_TEST_TIMEOUT_MS`,
  `AURORA_MAX_VERIFICATIONS` (varsayılan 0 = kapalı; opt-in).
- **CLI:** `aurora run --test-command "<cmd>" --max-verifications <n>`.
  Doğrulama skipped ise `completed WITHOUT verification` yazılır.

## Değişen Dosyalar

- `src/core/errors/types.ts` (yeni) — `ExecutionFailure`, `FailureEvidence`,
  `FailureVerdict`.
- `src/core/errors/ErrorClassifier.ts` (yeni).
- `src/core/agent/types.ts` — `Verifier`, `VerificationOutcome`,
  `AgentLimits.maxVerifications`, `RunStatus`'a `max_verifications`,
  `RunResult.verifications/lastVerification`, `ToolExecutionResult.mutatedWorkspace`.
- `src/core/agent/AgentLoop.ts` — `gateCompletion`, mutation takibi, doğrulama
  kaydı.
- `src/core/agent/AgentRuntime.ts` — test komutu varsa `CommandVerifier` kurar.
- `src/providers/execution/CommandVerifier.ts` (yeni).
- `src/providers/execution/TestSummary.ts` (yeni) — paylaşılan parser +
  `ranNoTests`.
- `src/tools/execution/RunTestsTool.ts` (yeni).
- `src/tools/types.ts` — `Tool.mutatesWorkspace`.
- `src/tools/ToolRegistry.ts` — `mutatedWorkspace` yalnızca başarıda.
- `src/tools/filesystem/WriteFileTool.ts` — `mutatesWorkspace: true`.
- `src/tools/index.ts` — `run_tests` kaydı, execution/validator/permissions
  runtime'a açılır.
- `src/config/Config.ts`, `.env.example`, `src/cli/commands/run.ts`.

## Çalıştırılan Testler

| Test | Sonuç | Not |
|---|---|---|
| `tests/unit/errors/error-classifier.test.ts` (21) | PASS | Kategori/eylem; yapısal sinyal önceliği; AbortError retry edilmez |
| `tests/unit/agent/verification.test.ts` (10) | PASS | Kapı mantığı; bütçe; skipped≠pass; mutation tetiği |
| `tests/unit/execution/run-tests-tool.test.ts` (9) | PASS | Exit-code verdict; vakum koşu; parser |
| `tests/unit/tools/tool-registry.test.ts` (24) | PASS | `mutatedWorkspace` yalnızca başarıda |
| `tests/unit/config.test.ts` (11) | PASS | Yeni alanlar; model env'den |
| `tests/integration/verification-live.test.ts` (8) | PASS | **Gerçek** `node --test`: yeşil/kırmızı/syntax/vakum/skipped |
| **Tam suite** | **258 PASS, 0 SKIP** | 25 dosya; 3 canlı Ollama entegrasyonu gerçekten koştu |

Mutasyon testi (testlerin gerçekten yakaladığını kanıtlamak için):
- `ToolRegistry`'de `result.ok &&` kaldırılınca → 1 test FAIL.
- `AgentLoop`'da `if (!hasMutated)` → `if (false)` → 3 test FAIL.
- `CommandVerifier`'da `ranNoTests(...)` → `if (false)` → 1 test FAIL.

## Kullanılan Kaynaklar

- Node.js v24.21.0, `node --test` çıktısı ve exit code — **bu makinede
  çalıştırılarak doğrulandı** (5 durum: pass, fail, syntax error, boş koşu,
  exit code 0). Önceki notta "boş koşu exit 1" yazıyordu; **yanlıştı**,
  ölçüm exit 0 gösterdi ve tasarım buna göre düzeltildi.
- `docs/adr/001-core-architecture.md`, ADR 004, ADR 005 — iç tasarım.
- OpenAI function/tool-calling şeması (Phase 2'de zaten kanal içinde).

## Alınan Kararlar

- Doğrulama **harici sinyale** dayanır; modelin öz-değerlendirmesi doğrulama
  sayılmaz (ADR 001/006).
- `completed` demek "harici kontrol kabul etti" demektir. Bütçe biterse
  `max_verifications` ile escalate edilir, sessizce kabul edilmez.
- `skipped` asla `pass` olarak raporlanmaz.
- Exit 0 tek başına yetmez: `node --test` boş koşuda 0 verir → fail sayılır.
- `mutatesWorkspace` tool'da bildirilir, core'da isimden çıkarılmaz.
- Doğrulama opt-in; varsayılan ayarlar Phase 1–3 davranışını korur.
- `run_tests` yalnızca test komutu yapılandırılmışsa kaydedilir.

## Varsayımlar

- Test komutu tek bir komuttur ve exit code'u anlamlıdır (yaygın
  runner'larda geçerli).
- `node --test` varsayılan glob'u projenin test dosyalarını bulur. Bulmazsa
  vakum koruması bunu **fail** yapar — sessiz pass olmaz.
- Aynı anda tek doğrulayıcı yeterli (ADR 001'deki ikinci sinyal katmanı
  ileri bir fazın işi).

## Kalan Problemler

- `ErrorClassifier`'ın metin sezgileri runner başına genişletilebilir; şu an
  Node/TS/Vitest/Jest desenleri ve yaygın hata kodları kapsanıyor.
- Doğrulama tek komutla sınırlı; lint + test + typecheck gibi çoklu sinyal
  zinciri henüz yok (bütçe tek sayaç).
- Retry'da üstel backoff yok; `Action` belirtiyor ama uygulama çağırana
  bırakılmış (şimdilik model bir sonraki turda yeniden dener).

## Sonraki Faz İçin Notlar

- Phase 5 (sub-agent): `Verifier` ve `mutatesWorkspace` alt agent'lara
  miras verilmeli; alt agent'ın doğrulama bütçesi ana bütçeden düşülmeli ki
  toplam maliyet sınırlı kalsın.
- Phase 6 (persistence): `max_verifications` durumu kurtarılabilir bir son
  durumdur; task store bunu `failed`den ayırmalı.
- Phase 7 (context): doğrulama gözlemleri (özellikle başarısız test çıktısı)
  token bütçesinde pahalıdır; compaction bunları öncelikli budayabilir.
