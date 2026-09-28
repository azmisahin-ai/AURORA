# Phase 6 Report — Persistence + Task Recovery

Date: 2026-09-28

## Yapılanlar

- **Görev kaydı (`core/task/types.ts`):** `TaskStatus` (altı durum), açık
  `TASK_TRANSITIONS` tablosu, `TaskRecord`, `TaskAttempt`, `TaskStore`
  arayüzü, `RecoveryReport`. Geçiş tablosu tek doğruluk kaynağıdır.
- **`FileTaskStore` (`core/task/FileTaskStore.ts`):** Her görev için
  `<root>/<id>.json`. Yazma **atomiktir**: temp dosya + `rename`. Böylece
  çakışan bir okuyucu yarım yazılmış kayıt göremez — Phase 6'nın tüm amacı
  budur.
- **Geçiş zorlaması:** `update()` tabloda olmayan her hareketi reddeder
  (`TaskTransitionError`), bilinmeyen id `TaskNotFoundError` atar. Terminal
  durumların tabloda **çıkış kenarı yoktur**, yani "terminal" tam olarak
  "düz geçişle çıkamaz" demektir.
- **`requeue()` — adlandırılmış tek geri dönüş yolu:** `running → queued`
  tabloda yoktur. Yeniden kuyruğa alma yalnızca bu adlandırılmış operasyondan
  geçer (crash kurtarma veya kaynak sınırına takılan koşu). Böylece düz bir
  `update()` çalışan bir görevi sessizce sıfırlayamaz.
- **Sınırlı kurtarma:** `recover()` yalnızca `running` kayıtları ele alır:
  deneme hakkı kaldıysa `queued`, tükendiyse `failed`. Planın kabul kriteri
  ("running → queued") **artı** ADR 001/006'nın gerektirdiği sınır. Rapor
  `requeued` / `exhausted` / `corrupt` olarak ayrıştırır.
- **Bozuk kayıt raporlanır, silinmez:** Okunamayan bir kayıt operatörün
  bilmesi gereken şeydir; `RecoveryReport.corrupt`'ta listelenir ve diskte
  bırakılır.
- **Kuyruk zehirlenmesi engeli:** `claimNext()`, deneme hakkı kalmamış
  `queued` bir kaydı `failed` yapıp devam eder; tek bir kayıt kuyruğu
  tıkayamaz.
- **`TaskRunner` (`core/task/TaskRunner.ts`):** Persistence ile agent
  döngüsünü buluşturur; tek kararı vardır — koşu sonucunun yaşam döngüsüne
  anlamı. `nextTaskStatus` açık bir tablodur (aşağıda). `TaskExecutor`
  portuna bağlıdır; `core/task` hiçbir provider/tool import etmez (ADR 001).
- **`AgentRuntime.createTaskExecutor()`:** `TaskExecutor` portunun agent
  döngüsü adaptörü. Her görev taze bir `AgentLoop` alır; görevler arası
  context sızıntısı yok.
- **CLI (`cli/commands/tasks.ts`):** `tasks add | list | show | recover | run`.
  `recover` kurtarma raporunu yazdırır; `run` önce `recover` eder, sonra
  kuyruğu koşar.
- **Config:** `AURORA_TASK_DIR` (varsayılan `./tasks`),
  `AURORA_TASK_MAX_ATTEMPTS` (varsayılan 3; pozitif tamsayı olmalı).

## Sonuç → durum eşlemesi (`nextTaskStatus`)

| Koşu durumu | Görev durumu | Gerekçe |
|---|---|---|
| `completed` | `completed` | Harici doğrulayıcı onayladı (ADR 006) |
| `aborted` | `waiting` | Çağıran duraklattı; devam ettirilebilir |
| `max_verifications` | `waiting` | Eskalasyon gerekir, kör yeniden yazma değil |
| `timeout` / `max_iterations` / `max_tool_calls` | retry | Sınıra takıldı, yanlış değil |
| `error` | `failed` | İşin kendisi başarısız |

"retry" = deneme kaldıysa `queued`, tükendiyse `failed`. Sınıra takılan bir
koşu yanlış cevap üretmemiştir, yeniden denemek meşrudur; `error` gerçek bir
başarısızlıktır, kör yeniden deneme onu yalnızca tekrarlar.

## Değişen Dosyalar

- `src/core/task/types.ts` (yeni) — durumlar, geçiş tablosu, arayüz, hatalar.
- `src/core/task/FileTaskStore.ts` (yeni) — atomik yazma, geçiş zorlaması,
  kurtarma, kuyruk.
- `src/core/task/TaskRunner.ts` (yeni) — executor portu, sonuç eşlemesi.
- `src/core/task/index.ts` (yeni).
- `src/core/agent/AgentRuntime.ts` — `createTaskExecutor()`.
- `src/cli/commands/tasks.ts` (yeni), `src/cli/index.ts` — `tasks` kaydı.
- `src/config/Config.ts`, `.env.example` — task ayarları.
- `src/index.ts` — yeni export'lar.
- `tests/unit/task/{transitions,file-task-store,task-runner}.test.ts` (yeni).
- `tests/integration/task-recovery.test.ts` (yeni).
- `tests/unit/{cli,config}.test.ts` — `tasks` komutu ve task ayarları.

## Çalıştırılan Testler

| Test | Sonuç | Not |
|---|---|---|
| `tests/unit/task/transitions.test.ts` (7) | PASS | Terminal = düz çıkış yok; self-geçiş yok; `running→queued` yok |
| `tests/unit/task/file-task-store.test.ts` (26) | PASS | Atomiklik, geçiş zorlaması, kurtarma, kuyruk, bozuk kayıt |
| `tests/unit/task/task-runner.test.ts` (14) | PASS | `nextTaskStatus` tablosu; drain; fırlatılan hata → failed |
| `tests/integration/task-recovery.test.ts` (4) | PASS | **Gerçek** restart simülasyonu + gerçek `AgentLoop` |
| `tests/unit/cli.test.ts` (6) | PASS | `tasks` alt komutları kayıtlı |
| `tests/unit/config.test.ts` (13) | PASS | `taskDir`, `taskMaxAttempts`, geçersiz değer reddi |
| **Tam suite** | **346 PASS, 0 SKIP** | 34 dosya; canlı Ollama entegrasyonları gerçekten koştu |

### Atomiklik iddiasının ölçümü

`rename` yerine düz `writeFile` kullanıldığında yarım okumanın gerçekten
gözlenip gözlenmediği **ölçüldü** (2 MB kayıt, eşzamanlı okuyucu):

| Yazma stratejisi | Yarım (parse edilemez) okuma | Temiz okuma |
|---|---|---|
| temp + `rename` | **0** | 84 |
| doğrudan `writeFile` | **221** | 244 |

`never exposes a torn record to a concurrent reader` testi bu ölçümü kodlar:
40 yeniden yazma sırasında kaydı sürekli okuyup parse eder ve sıfır yarım okuma
ister. `rename` kaldırılıp yerine düz yazma konunca test **FAIL** eder.

### Mutasyon testi

Testlerin gerçekten yakaladığını kanıtlamak için dört mutasyon denendi; dördü
de yakalandı:

| Mutasyon | Sonuç |
|---|---|
| `update()`'te geçiş zorlaması kaldırıldı | 2 test FAIL |
| Atomik yazma → düz `writeFile` | 1 test FAIL (yarım okuma testi) |
| Sınırlı kurtarma → her zaman requeue | 2 test FAIL |
| Bozuk kayıt raporu yutuldu | 2 test FAIL |
| Requeue'da `history` düşürüldü | 3 test FAIL |

> Not: Atomik yazma mutasyonu ilk denemede **yakalanmadı** — eski test yalnızca
> "dosya parse edilebilir" diyordu, eşzamanlı bir okuyucuyu modellemiyordu.
> Test bu yüzden yeniden yazıldı; şimdi yakalıyor.

## Kullanılan Kaynaklar

- `docs/research/frameworks-comparison.md` — dayanıklı runtime'ların ortak
  fikri: işin *durumu* dışsallaştırılır, restart veri kaybı olmaz
  (LangGraph checkpointing, Vercel AI SDK 7 durable steps, Inngest step
  memoization, Nexora durable runs; 2026-09-28 erişimli kaynaklar).
- `docs/adr/001-core-architecture.md` (sınırlı döngü, katman yönü),
  ADR 002 (dosya sistemi deposu + arayüz arkasına saklama),
  ADR 006 (harici doğrulama, eskalasyon).
- Node.js v24.21.0 — `rename` atomikliği bu makinede ölçülerek doğrulandı.

## Alınan Kararlar

- Kayıtlar atomik yazılır (temp + `rename`); torn read testle korunur (ADR 008).
- Geçişler açık tablodan zorlanır; terminal = düz geçişle çıkış yok.
- `requeue()` yeniden kuyruğa almanın tek adlandırılmış yoludur.
- Kurtarma **sınırlıdır**: deneme hakkı kalmayan kesintili görev `failed` olur,
  sonsuz requeue döngüsü yok.
- Bozuk kayıt silinmez, raporlanır.
- Koşu sonucu → görev durumu eşlemesi `TaskRunner`'ın tek kararıdır; açık
  tablo olarak yazılı ve test edilmiştir.
- `core/task` provider/tool import etmez; `TaskExecutor` portu üzerinden
  çalışır.
- Depo tek process içindir; process'ler arası kilit **yoktur** ve bu açıkça
  belgelenmiştir (yanlış bir garanti vermektense sınırı söylemek).

## Varsayımlar

- Tek bir worker kuyruğu tüketir. `claimNext()` in-process serileştirilir;
  iki process aynı dizini paylaşırsa bu desteklenmez.
- Bir görevin prompt'u, o görevi tek başına yürütmeye yeter. Görev metni
  kendi kendine yeterli olmalıdır — alt agent delegasyonunda olduğu gibi.
- Deneme bütçesi (varsayılan 3) makul bir üst sınırdır; politika değil,
  güvenli bir varsayılan.

## Kalan Problemler

- Görev başına token maliyeti kaydedilmiyor; `attempts` ve `history` var ama
  token/kredi muhasebesi yok. Faz 7 (Context + Memory) token bütçesine
  dokunuyor; orada görevle ilişkilendirmek doğal sonraki adım.
- `waiting` durumundaki bir görevi devam ettirecek bir komut yok
  (`tasks run` yalnızca `queued` tüketir). `waiting → queued` geçişi
  (`requeue`) hazır; onu dışarı açan bir CLI yolu eklenebilir.
- Çok-process/çok-worker desteği yok (ADR 008'de belgelendi). Gerekirse
  `TaskStore` arayüzünün arkasına SQLite/Postgres yazılır.
- `recover()` senkron tam tarama yapar; çok sayıda kayıtta indeks gerekebilir.
  MVP ölçeğinde yeterli.

## Sonraki Faz İçin Notlar

- Phase 7 (Context + Memory) `ContextBuilder` ve bellek katmanlarını ekler.
  Görev kaydı, uzun süreli bir görevin bağlamını yeniden kurmak için gereken
  `prompt` + `history` + `output` alanlarını zaten taşıyor; `TaskRecord` bu
  bağlamın doğal kaynağıdır.
- `TaskExecutor` portu, gelecekte bir görevi farklı bir yürütücüyle (ör. bir
  plan-execute döngüsü) koşmak için hazır bir seam'dir.
- Görev başına token muhasebesi, `TaskAttempt`'e bir alan eklemekle başlar.
